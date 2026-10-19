/** Paragraph-first delivery. Fenced code, tables and inline Markdown atoms stay readable. */
export function splitChatMessage(content:string,maxChars=220):string[] {
  const blocks:string[]=[];let current:string[]=[],fence:string|undefined;
  const flush=()=>{const text=current.join('\n').trim();if(text)blocks.push(text);current=[];};
  for(const line of content.replace(/\r\n/g,'\n').split('\n')) {
    const marker=line.match(/^\s*(`{3,}|~{3,})/);
    if(fence){current.push(line);if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length){flush();fence=undefined;}continue;}
    if(marker){flush();fence=marker[1];current.push(line);continue;}
    if(!line.trim()){flush();continue;}
    current.push(line);
  }
  flush();
  const result:string[]=[];
  const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
  for(const block of blocks) {
    if(/^\s*(?:`{3,}|~{3,})/.test(block)||/^\s*\|?\s*:?-{3,}/m.test(block)&&block.includes('|')){result.push(block);continue;}
    // Do not cut inside links, code spans, emphasis, URLs or a Unicode grapheme.
    const atoms=block.split(/(`+[^`\n]+`+|!?\[[^\]\n]*\]\([^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|https?:\/\/\S+)/g).flatMap((part,i)=>i%2?[part]:Array.from(graphemes.segment(part),s=>s.segment)).filter(Boolean);
    let remaining=atoms;
    while(remaining.length) {
      let size=0,end=0,preferred=0;
      for(;end<remaining.length;end++) {
        const length=Array.from(remaining[end]).length;
        if(size+length>maxChars&&end>0)break;
        size+=length;
        if(/[。！？!?；;\n]$/.test(remaining[end])||/^[. ]$/.test(remaining[end]))preferred=end+1;
      }
      const cut=end===remaining.length?end:preferred>0?preferred:Math.max(1,end);
      const text=remaining.slice(0,cut).join('').trim();if(text)result.push(text);
      remaining=remaining.slice(cut);
    }
  }
  return result.length?result:[''];
}
