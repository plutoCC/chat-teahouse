import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechQueue,spokenText,speechChunks,defaultVoice,type SpeechState} from '../src/speech.js';

test('speech reads prose, strips code, links, images and HTML and chunks without breaking unicode',()=>{
 const text=spokenText('# 标题\n\n**观点**：正文。\n\n```js\nsecretCode()\n```\n\n`inlineSecret` [链接文字](https://example.com) ![image](x.png)\n\n<div>hidden</div>\n\n最后一句。');
 assert.match(text,/标题/);assert.match(text,/观点/);assert.match(text,/最后一句/);assert.doesNotMatch(text,/secretCode|inlineSecret|example|链接文字|image|hidden/);
 const source='😀'.repeat(500);const chunks=speechChunks(source);assert.equal(chunks.join(''),source);assert.ok(chunks.every(c=>Array.from(c).length<=220));
});
function fixture(t:any,voice=true){
 let current:any;const spoken:any[]=[],states:SpeechState[]=[],errors:string[]=[];
 const synth={speak(u:any){spoken.push(u);current=u;},cancel(){current=undefined;},pause(){},resume(){}} as unknown as SpeechSynthesis;
 const q=new SpeechQueue(synth,text=>({text} as SpeechSynthesisUtterance),()=>voice?({lang:'zh-CN',localService:true} as SpeechSynthesisVoice):undefined,s=>states.push(s),e=>errors.push(e));
 t.after(()=>q.stop());const item=(id:string,text=id)=>({id,author:id,text,preference:defaultVoice});
 return {q,spoken,states,errors,item,end:()=>current?.onend?.(),active:()=>current};
}
test('queue serializes live messages, pauses/resumes, skips and ignores cancelled callbacks',t=>{
 const f=fixture(t);f.q.add([f.item('one'),f.item('two')]);assert.equal(f.spoken.length,1);
 f.q.pause();f.q.add([f.item('three')]);assert.equal(f.states.at(-1)?.paused,true);
 f.end();assert.equal(f.spoken.length,1);f.q.resume();assert.equal(f.spoken.at(-1).text,'two');
 const stale=f.active();f.q.skip();assert.equal(f.spoken.at(-1).text,'three');stale.onend();assert.equal(f.spoken.length,3);
 f.end();assert.equal(f.states.at(-1)?.pending,0);assert.deepEqual(f.errors,[]);
});
test('long messages finish their chunks before the next speaker and stop cancels all',t=>{
 const f=fixture(t);f.q.add([f.item('long','甲'.repeat(450)),f.item('next')]);
 f.end();f.end();assert.equal(f.spoken.length,3);assert.equal(f.states.at(-1)?.author,'long');f.end();assert.equal(f.spoken.at(-1).text,'next');
 const stale=f.active();f.q.stop();stale.onend();assert.equal(f.states.at(-1)?.pending,0);assert.equal(f.spoken.length,4);
});
test('missing voices and synthesis errors release the queue with a visible error',t=>{
 const missing=fixture(t,false);missing.q.add([missing.item('one')]);assert.equal(missing.spoken.length,0);assert.equal(missing.errors.length,1);assert.equal(missing.states.at(-1)?.pending,0);
 const f=fixture(t);f.q.add([f.item('one'),f.item('two')]);f.active().onerror();assert.equal(f.errors.length,1);assert.equal(f.states.at(-1)?.pending,0);assert.equal(f.spoken.length,1);
});
