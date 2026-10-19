import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {BookOpen,Bold,Underline,Star,MessageSquare,Plus,X,Trash2,ArrowUpRight,RefreshCw} from 'lucide-react';
import type {LocalApi} from './SubscriptionPanel';
import type {Group,Message} from '../shared/types';
import {emptyNoteStyle,type NotebookEntry,type NoteAnchor,type NoteStyle} from '../shared/notebook';
import {annotationPlugin,normalizeNotebookMarkdown} from '../shared/notebook-markdown';
import './notebook.css';

export interface SelectionDraft {groupId:string;anchor:NoteAnchor;}
export function selectedAnnotation(entries:NotebookEntry[],draft:SelectionDraft){
  return entries.filter(e=>e.groupId===draft.groupId&&e.anchor?.messageId===draft.anchor.messageId&&e.anchor.start===draft.anchor.start&&e.anchor.end===draft.anchor.end&&e.anchor.quote===draft.anchor.quote).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
}
export function SelectionToolbar({draft,entries,api,changed,comment,close}:{draft:SelectionDraft;entries:NotebookEntry[];api:LocalApi;changed:(entry:NotebookEntry|null,removedId?:string)=>void;comment:()=>void;close:()=>void}){
  const ref=useRef<HTMLDivElement>(null),[position,setPosition]=useState({left:8,top:0,visible:false}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const existing=selectedAnnotation(entries,draft),style=existing?.style??emptyNoteStyle,starred=existing?.starred??false;
  useLayoutEffect(()=>{
    const place=()=>{
      const root=document.querySelector(`[data-annotation-message="${CSS.escape(draft.anchor.messageId)}"]`),toolbar=ref.current;
      if(!root||!toolbar)return;
      const range=document.createRange(),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let offset=0,started=false,ended=false;
      while(walker.nextNode()){const node=walker.currentNode,length=node.textContent?.length??0;if(!started&&offset+length>draft.anchor.start){range.setStart(node,draft.anchor.start-offset);started=true;}if(started&&offset+length>=draft.anchor.end){range.setEnd(node,draft.anchor.end-offset);ended=true;break;}offset+=length;}
      if(!ended)return;
      const boxes=[...range.getClientRects()].filter(r=>r.width&&r.height),rect=boxes.at(-1);if(!rect)return;
      const clip=root.closest('.messages')?.getBoundingClientRect(),width=toolbar.offsetWidth,height=toolbar.offsetHeight;
      const visible=rect.bottom>Math.max(0,clip?.top??0)&&rect.top<Math.min(innerHeight,clip?.bottom??innerHeight);
      setPosition({left:Math.max(8,Math.min(innerWidth-width-8,rect.left+rect.width/2-width/2)),top:Math.max(8,Math.min(innerHeight-height-8,rect.bottom+8)),visible});
    };
    place();const observer=new ResizeObserver(place);if(ref.current)observer.observe(ref.current);
    window.addEventListener('scroll',place,true);window.addEventListener('resize',place);
    return()=>{observer.disconnect();window.removeEventListener('scroll',place,true);window.removeEventListener('resize',place);};
  },[draft,entries,error]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node)&&!busy)close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)close();};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[close,busy]);
  const save=async(patch:{style?:NoteStyle;starred?:boolean})=>{
    if(busy)return;setBusy(true);setError('');
    const fields={title:existing?.title??'',body:existing?.body??'',category:existing?.category??'',style:patch.style??style,starred:patch.starred??starred};
    try{
      if(existing&&!fields.body.trim()&&!fields.starred&&!fields.style.bold&&!fields.style.underline&&fields.style.color==='default'&&fields.style.highlight==='none'){
        await api('/api/notebook/'+existing.id,'DELETE',{expectedRevision:existing.revision});changed(null,existing.id);
      }else{
        const {author,...anchor}=draft.anchor;
        const saved=await api<NotebookEntry>(existing?'/api/notebook/'+existing.id:'/api/notebook',existing?'PUT':'POST',existing?{...fields,expectedRevision:existing.revision}:{...fields,kind:'annotation',groupId:draft.groupId,anchor});changed(saved);
      }
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <div ref={ref} className="selection-note-toolbar" role="toolbar" aria-label="选中文字操作" style={{left:position.left,top:position.top,visibility:position.visible?'visible':'hidden'}}>
    <div className="selection-note-actions">
      <button type="button" disabled={busy} aria-label="加粗" aria-pressed={style.bold} onPointerDown={e=>e.preventDefault()} onClick={()=>void save({style:{...style,bold:!style.bold}})}><Bold size={15}/><span>加粗</span></button>
      <button type="button" disabled={busy} aria-label="下划线" aria-pressed={style.underline} onPointerDown={e=>e.preventDefault()} onClick={()=>void save({style:{...style,underline:!style.underline}})}><Underline size={15}/><span>下划线</span></button>
      <button type="button" disabled={busy} aria-label="收藏" aria-pressed={starred} onPointerDown={e=>e.preventDefault()} onClick={()=>void save({starred:!starred})}><Star size={15} fill={starred?'currentColor':'none'}/><span>{starred?'已收藏':'收藏'}</span></button>
      <button type="button" disabled={busy} aria-label="评论" onPointerDown={e=>e.preventDefault()} onClick={comment}><MessageSquare size={15}/><span>评论</span></button>
      <select title="文字颜色" aria-label="文字颜色" disabled={busy} value={style.color} onChange={e=>void save({style:{...style,color:e.target.value as NoteStyle['color']}})}><option value="default">颜色</option><option value="red">红色</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="purple">紫色</option></select>
      <select title="高亮背景" aria-label="高亮背景" disabled={busy} value={style.highlight} onChange={e=>void save({style:{...style,highlight:e.target.value as NoteStyle['highlight']}})}><option value="none">高亮</option><option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="pink">粉色</option></select>
      <button type="button" disabled={busy} aria-label="关闭选字工具栏" onClick={close}><X size={14}/></button>
    </div>{error&&<p className="inline-error" role="alert">{error}</p>}
  </div>;
}
export function AnnotatedMessage({message,entries,select}:{message:Message;entries:NotebookEntry[];select:(value:SelectionDraft)=>void}){
  const ref=useRef<HTMLDivElement>(null);
  const plugin=useMemo(()=>annotationPlugin(entries),[entries]);
  const capture=()=>{
    const root=ref.current,selection=window.getSelection();
    if(!root||!selection||selection.isCollapsed||selection.rangeCount!==1||message.status==='streaming')return;
    const range=selection.getRangeAt(0);
    if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return;
    const quote=range.cloneContents().textContent??'';if(!quote.trim()||quote.length>12000)return;
    const prefix=document.createRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset);
    const start=prefix.cloneContents().textContent?.length??0;
    select({groupId:message.groupId,anchor:{messageId:message.id,start,end:start+quote.length,quote,author:message.author}});
  };
  return <><div className="markdown" ref={ref} data-annotation-message={message.id} onPointerUp={capture} onKeyUp={capture}>
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[normalizeNotebookMarkdown,plugin]} skipHtml components={{a:({href,children})=><a href={href&&/^(https?:\/\/|#)/i.test(href)?href:undefined} target="_blank" rel="noopener noreferrer">{children}</a>}}>{message.content||(message.sticker?'':message.status==='streaming'?'正在整理观点…':'尚未生成回复')}</Markdown>
    {message.status==='streaming'&&<span className="stream-cursor"/>}
  </div>{entries.some(e=>e.body.trim()||e.starred)&&<div className="message-annotations">{entries.filter(e=>e.body.trim()||e.starred).map(e=><details key={e.id}><summary>{e.starred?'★ 收藏':'▤ 评论'} · {e.anchor?.quote.slice(0,32)}{(e.anchor?.quote.length??0)>32?'…':''}</summary><blockquote>{e.anchor?.quote}</blockquote>{e.body&&<p>{e.body}</p>}{e.category&&<small>分类：{e.category}</small>}</details>)}</div>}</>;
}

interface EditorProps {initial?:NotebookEntry;draft?:SelectionDraft;commentOnly?:boolean;groups:Group[];groupId:string;categories:string[];api:LocalApi;saved:(entry:NotebookEntry)=>void;cancel:()=>void;}
export function NotebookEditor({initial,draft,commentOnly=false,groups,groupId,categories,api,saved,cancel}:EditorProps){
  const anchor=initial?.anchor??draft?.anchor,kind=anchor?'annotation':'note';
  const [target,setTarget]=useState(initial?.groupId??draft?.groupId??groupId);
  const [title,setTitle]=useState(initial?.title??''),[body,setBody]=useState(initial?.body??''),[category,setCategory]=useState(initial?.category??'');
  const [style,setStyle]=useState<NoteStyle>(initial?.style??{...emptyNoteStyle}),[starred,setStarred]=useState(initial?.starred??false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const update=(patch:Partial<NoteStyle>)=>setStyle(s=>({...s,...patch}));
  const hasContent=commentOnly?!!body.trim():kind==='note'?!!(title.trim()||body.trim()):!!(body.trim()||starred||style.bold||style.underline||style.color!=='default'||style.highlight!=='none');
  return <form className="notebook-editor" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{
    const fields={title,body,category,style,starred};
    const result=await api<NotebookEntry>(initial?'/api/notebook/'+initial.id:'/api/notebook',initial?'PUT':'POST',initial?{...fields,expectedRevision:initial.revision}:{...fields,kind,groupId:target,...(anchor?{anchor:{messageId:anchor.messageId,start:anchor.start,end:anchor.end,quote:anchor.quote}}:{})});
    saved(result);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
    {!commentOnly&&<><h3>{initial?'编辑':anchor?'标注选中文字':'记录新灵感'}</h3>
    <label>所属群聊<select aria-label="笔记所属群聊" value={target} disabled={!!initial||!!anchor||busy} onChange={e=>setTarget(e.target.value)}>{groups.map(g=><option key={g.id} value={g.id}>{g.name}{g.archived?'（已归档）':''}</option>)}</select></label></>}
    {anchor?<><blockquote className={`notebook-quote ${style.bold?'note-bold':''} ${style.underline?'note-underline':''} note-color-${style.color} note-highlight-${style.highlight}`}>{anchor.quote}<cite>— {anchor.author}</cite></blockquote>{!commentOnly&&<div className="annotation-tools">
      <button type="button" aria-label="加粗" aria-pressed={style.bold} onClick={()=>update({bold:!style.bold})}><Bold size={17}/>加粗</button>
      <button type="button" aria-label="下划线" aria-pressed={style.underline} onClick={()=>update({underline:!style.underline})}><Underline size={17}/>下划线</button>
      <label>文字颜色<select aria-label="文字颜色" value={style.color} onChange={e=>update({color:e.target.value as NoteStyle['color']})}><option value="default">原色</option><option value="red">红色</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="purple">紫色</option></select></label>
      <label>高亮背景<select aria-label="高亮背景" value={style.highlight} onChange={e=>update({highlight:e.target.value as NoteStyle['highlight']})}><option value="none">无</option><option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="pink">粉色</option></select></label>
    </div>}</>:<label>标题<input aria-label="笔记标题" value={title} maxLength={120} onChange={e=>setTitle(e.target.value)} placeholder="给这个灵感起个名字"/></label>}
    <label>{anchor?'我的评论':'笔记内容'}<textarea autoFocus={commentOnly} aria-label={anchor?'我的评论':'笔记内容'} value={body} maxLength={20000} rows={anchor?3:7} onChange={e=>setBody(e.target.value)} placeholder={anchor?'为什么记下这句话？（可选）':'写下你的想法，仅自己可见…'}/></label>
    {!commentOnly&&<div className="notebook-editor-meta"><label>分类<input aria-label="笔记分类" list="notebook-categories" value={category} maxLength={40} onChange={e=>setCategory(e.target.value)} placeholder="如：产品灵感、待验证"/><datalist id="notebook-categories">{categories.map(c=><option key={c} value={c}/>)}</datalist></label><button type="button" className="notebook-star" aria-pressed={starred} onClick={()=>setStarred(!starred)}><Star size={17} fill={starred?'currentColor':'none'}/>{starred?'已收藏':'收藏'}</button></div>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <div className="notebook-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancel}>取消</button><button className="primary-button" disabled={busy||!hasContent||!target}>{busy?'保存中…':commentOnly?'保存评论':'保存'+(anchor?'标注':'笔记')}</button></div>
  </form>;
}

export function NotebookDialog({scope,groups,currentGroup,api,changed,close,jump}:{scope:string;groups:Group[];currentGroup:string;api:LocalApi;changed:()=>void;close:()=>void;jump:(entry:NotebookEntry)=>void}){
  const ref=useRef<HTMLDialogElement>(null),alive=useRef(true),sequence=useRef(0);
  const [entries,setEntries]=useState<NotebookEntry[]>([]),[filterGroup,setFilterGroup]=useState(scope==='all'?'':scope),[type,setType]=useState('all'),[category,setCategory]=useState('all'),[search,setSearch]=useState('');
  const [editing,setEditing]=useState<NotebookEntry|'new'|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[deleting,setDeleting]=useState('');
  const dismiss=()=>{if(!editing||window.confirm('放弃尚未保存的笔记修改？'))close();};
  const refresh=async()=>{const n=++sequence.current;setLoading(true);try{const data=await api<NotebookEntry[]>('/api/notebook');if(alive.current&&n===sequence.current){setEntries(data);setError('');}}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current&&n===sequence.current)setLoading(false);}};
  useEffect(()=>{alive.current=true;ref.current?.showModal();void refresh();return()=>{alive.current=false;ref.current?.close();};},[]);
  const categories=[...new Set(entries.map(e=>e.category).filter(Boolean))].sort();
  const visible=entries.filter(e=>(!filterGroup||e.groupId===filterGroup)&&(category==='all'||'category:'+e.category===category)&&(type==='all'||type==='starred'&&e.starred||type==='note'&&e.kind==='note'||type==='annotation'&&e.kind==='annotation'||type==='comment'&&e.kind==='annotation'&&!!e.body.trim())&&[e.title,e.body,e.anchor?.quote,e.anchor?.author,e.category].join(' ').toLowerCase().includes(search.toLowerCase()));
  return <dialog ref={ref} className="modal wide notebook-modal" onCancel={e=>{e.preventDefault();dismiss();}} onClick={e=>{if(e.target===e.currentTarget)dismiss();}}><div className="modal-shell"><header className="modal-header"><div><h2><BookOpen size={21}/> {scope==='all'?'我的笔记本':'群聊笔记'}</h2><p>仅供自己整理 · 不发送给 AI · 不改变原发言</p></div><button className="icon-button" aria-label="关闭笔记本" onClick={dismiss}><X size={20}/></button></header>
    {editing?<NotebookEditor key={typeof editing==='string'?'new':editing.id} initial={typeof editing==='string'?undefined:editing} groups={groups} groupId={filterGroup||currentGroup||groups[0]?.id||''} categories={categories} api={api} saved={()=>{setEditing(null);changed();void refresh();}} cancel={()=>setEditing(null)}/>:<div className="notebook-content">
      <div className="notebook-top"><input aria-label="搜索笔记" placeholder="搜索句子、评论或灵感…" value={search} onChange={e=>setSearch(e.target.value)}/><button className="secondary-button" disabled={loading} aria-label="刷新笔记" onClick={()=>void refresh()}><RefreshCw size={15}/></button><button className="primary-button" disabled={!groups.length} onClick={()=>setEditing('new')}><Plus size={15}/>新建笔记</button></div>
      <div className="notebook-filters"><label>群聊<select aria-label="筛选群聊" value={filterGroup} onChange={e=>setFilterGroup(e.target.value)}><option value="">全部群聊</option>{groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select></label><label>内容<select aria-label="筛选内容" value={type} onChange={e=>setType(e.target.value)}><option value="all">全部内容</option><option value="starred">收藏</option><option value="note">我的笔记</option><option value="annotation">发言标注</option><option value="comment">我的评论</option></select></label><label>分类<select aria-label="筛选分类" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">全部分类</option><option value="category:">未分类</option>{categories.map(c=><option key={c} value={'category:'+c}>{c}</option>)}</select></label></div>
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <p className="notebook-count">{loading?'正在读取…':`${visible.length} 条记录`}</p>
      {!loading&&!visible.length&&<div className="notebook-empty"><BookOpen size={30}/><h3>把值得留下的想法记在这里</h3><p>选中聊天消息中的文字，可以标注、收藏或评论；也可以新建自己的笔记。</p></div>}
      <div className="notebook-list">{visible.map(entry=><article className="notebook-card" key={entry.id}><div className="notebook-card-meta"><span>{entry.kind==='note'?'我的笔记':entry.starred?'收藏句子':'发言标注'}{entry.starred&&' ★'}</span><span>{groups.find(g=>g.id===entry.groupId)?.name??'原群聊'} · {entry.category||'未分类'}</span></div>
        {entry.anchor?<blockquote className={`${entry.style.bold?'note-bold':''} ${entry.style.underline?'note-underline':''} note-color-${entry.style.color} note-highlight-${entry.style.highlight}`}>{entry.anchor.quote}<cite>— {entry.anchor.author}</cite></blockquote>:<h3>{entry.title||'未命名笔记'}</h3>}
        {entry.body&&<p className="notebook-body">{entry.kind==='annotation'&&<MessageSquare size={13}/>} {entry.body}</p>}
        <footer><time>{new Date(entry.updatedAt).toLocaleString('zh-CN')}</time><div>{entry.anchor&&<button className="text-button" onClick={()=>jump(entry)}><ArrowUpRight size={14}/>查看原消息</button>}<button className="text-button" onClick={()=>setEditing(entry)}>编辑</button><button className="text-button danger" disabled={!!deleting} onClick={async()=>{if(!window.confirm('删除这条笔记 / 标注？原消息会保留。'))return;setDeleting(entry.id);try{await api('/api/notebook/'+entry.id,'DELETE',{expectedRevision:entry.revision});changed();await refresh();}catch(e){setError((e as Error).message);}finally{setDeleting('');}}}><Trash2 size={13}/>删除</button></div></footer></article>)}</div>
    </div>}</div></dialog>;
}
