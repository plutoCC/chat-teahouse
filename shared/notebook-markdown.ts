import type {Root,RootContent,Element,Text} from 'hast';
import type {Plugin} from 'unified';
import type {NotebookEntry} from './notebook.js';

/** Shared by the server and renderer so offsets refer to displayed text, not Markdown syntax. */
export const normalizeNotebookMarkdown:Plugin<[],Root>=()=>tree=>{
  function walk(node:Root|Element){
    node.children=(node.children as RootContent[]).flatMap((child):RootContent[]=>{
      if(child.type==='raw')return [];
      if(child.type==='element'){
        if(child.tagName==='img')return [{type:'element',tagName:'span',properties:{className:['blocked-image']},children:[{type:'text',value:`[图片未加载：${child.properties.alt||'远程图片'}]`}]} as Element];
        walk(child);
      }
      // React's table renderer drops whitespace between structural table elements.
      if(node.type==='element'&&['table','thead','tbody','tfoot','tr'].includes(node.tagName)&&child.type==='text'&&!child.value.trim())return [];
      return [child];
    }) as typeof node.children;
  }
  walk(tree);
};
export function notebookTreeText(tree:Root|RootContent):string {
  if(tree.type==='text')return tree.value;
  return 'children' in tree?tree.children.map(notebookTreeText).join(''):'';
}
export function annotationPlugin(entries:NotebookEntry[]):Plugin<[],Root>{
  return ()=>tree=>{
    const full=notebookTreeText(tree);
    const valid=entries.filter(e=>e.anchor&&full.slice(e.anchor.start,e.anchor.end)===e.anchor.quote)
      .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id));
    let offset=0;
    function walk(node:Root|Element){
      node.children=(node.children as RootContent[]).flatMap((child):RootContent[]=>{
        if(child.type==='element'){walk(child);return [child];}
        if(child.type!=='text')return [child];
        const start=offset;offset+=child.value.length;
        const hits=valid.filter(e=>e.anchor!.start<offset&&e.anchor!.end>start);
        if(!hits.length)return [child];
        const cuts=[...new Set([start,offset,...hits.flatMap(e=>[Math.max(start,e.anchor!.start),Math.min(offset,e.anchor!.end)])])].sort((a,b)=>a-b);
        return cuts.slice(0,-1).map((from,i):Text|Element=>{
          const to=cuts[i+1],text:Text={type:'text',value:child.value.slice(from-start,to-start)};
          const covering=hits.filter(e=>e.anchor!.start<=from&&e.anchor!.end>=to);
          if(!covering.length)return text;
          const colored=covering.filter(e=>e.style.color!=='default').at(-1),highlighted=covering.filter(e=>e.style.highlight!=='none').at(-1);
          return {type:'element',tagName:'span',properties:{className:['user-annotation',...(covering.some(e=>e.style.bold)?['note-bold']:[]),...(covering.some(e=>e.style.underline)?['note-underline']:[]),`note-color-${colored?.style.color??'default'}`,`note-highlight-${highlighted?.style.highlight??'none'}`],title:covering.map(e=>e.body?`我的评论：${e.body}`:e.starred?'已收藏':'我的标注').join('\n')},children:[text]};
        });
      }) as typeof node.children;
    }
    walk(tree);
  };
}
