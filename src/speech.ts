import {unified} from 'unified';
import remarkParse from 'remark-parse';

/** Read prose only. Never send Markdown code, URLs, HTML or hidden reasoning to TTS. */
export function spokenText(markdown:string):string {
  const tree=unified().use(remarkParse).parse(markdown);
  const visit=(node:any):string=>{
    if(['code','inlineCode','html','image','imageReference','link','linkReference','definition'].includes(node.type))return '';
    if(node.type==='text')return node.value;
    return (node.children??[]).map(visit).join(['paragraph','heading','strong','emphasis','delete'].includes(node.type)?'':'\n');
  };
  return visit(tree).replace(/https?:\/\/\S+/g,'').replace(/[\t ]+/g,' ').replace(/\n+/g,'\n').trim();
}
export function speechChunks(text:string):string[]{
  const chars=Array.from(text),parts:string[]=[];
  while(chars.length){let end=Math.min(220,chars.length);if(end<chars.length){for(let i=end-1;i>=80;i--)if(/[。！？；.!?\n]/.test(chars[i])){end=i+1;break;}}
    const part=chars.splice(0,end).join('').trim();if(part)parts.push(part);
  }return parts;
}
export interface VoicePreference {voice:string;rate:number;volume:number;}
export const defaultVoice:VoicePreference={voice:'',rate:1,volume:1};
export interface SpeechItem {id:string;author:string;text:string;preference:VoicePreference;}
export interface SpeechState {author:string;messageId:string;pending:number;paused:boolean;}
export class SpeechQueue {
  private queue:SpeechItem[]=[];
  private current?:{item:SpeechItem;chunks:string[];index:number};
  private utterance?:SpeechSynthesisUtterance;
  private generation=0;
  private timer?:ReturnType<typeof setTimeout>;
  private paused=false;
  constructor(private synth:SpeechSynthesis,private make:(text:string)=>SpeechSynthesisUtterance,private voice:(id:string)=>SpeechSynthesisVoice|undefined,private changed:(state:SpeechState)=>void,private failed:(message:string)=>void){}
  private emit(){this.changed({author:this.current?.item.author??'',messageId:this.current?.item.id??'',pending:this.queue.length+(this.current?1:0),paused:this.paused});}
  add(items:SpeechItem[]){for(const item of items)if(item.text.trim())this.queue.push(item);this.next();}
  private next(){if(this.current||this.paused){this.emit();return;}const item=this.queue.shift();if(!item){this.emit();return;}this.current={item,chunks:speechChunks(item.text),index:0};this.say();}
  private say(){
    const current=this.current;if(!current)return;
    const selected=this.voice(current.item.preference.voice);
    if(!selected){this.stop();this.failed('没有可用的朗读声音。请安装中文语音或在朗读设置中选择可用音色。');return;}
    const token=++this.generation,utterance=this.make(current.chunks[current.index]);this.utterance=utterance;
    utterance.voice=selected;utterance.lang=selected.lang;utterance.rate=current.item.preference.rate;utterance.volume=current.item.preference.volume;
    const valid=()=>this.generation===token;
    utterance.onend=()=>{if(!valid())return;clearTimeout(this.timer);this.utterance=undefined;if(++current.index<current.chunks.length){if(!this.paused)this.say();else this.emit();}else{this.current=undefined;this.next();}};
    utterance.onerror=()=>{if(!valid())return;this.stop();this.failed('浏览器朗读未完成，请检查声音和音频权限，再点击开启或重播。');};
    this.emit();this.armTimeout();try{this.synth.speak(utterance);}catch{utterance.onerror?.({} as SpeechSynthesisErrorEvent);}
  }
  private armTimeout(){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.stop();this.failed('浏览器朗读长时间没有结束，已清空播放队列；可以重播消息。');},120000);}
  pause(){if(this.paused)return;this.paused=true;clearTimeout(this.timer);this.synth.pause();this.emit();}
  resume(){if(!this.paused)return;this.paused=false;if(this.utterance){this.synth.resume();this.armTimeout();this.emit();}else if(this.current)this.say();else this.next();}
  skip(){++this.generation;clearTimeout(this.timer);this.utterance=undefined;this.current=undefined;this.synth.cancel();this.next();}
  stop(){++this.generation;clearTimeout(this.timer);this.utterance=undefined;this.current=undefined;this.queue=[];this.paused=false;this.synth.cancel();this.emit();}
}
