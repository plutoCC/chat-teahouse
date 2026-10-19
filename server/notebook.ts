import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import {z} from 'zod';
import type {Root} from 'hast';
import {Store} from './store.js';
import {DiscussionError} from './scheduler.js';
import {idSchema} from './validation.js';
import {emptyNoteStyle,noteColors,noteHighlights,type NotebookEntry} from '../shared/notebook.js';
import {normalizeNotebookMarkdown,notebookTreeText} from '../shared/notebook-markdown.js';

const processor=unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(normalizeNotebookMarkdown);
export function messageNotebookText(markdown:string){return notebookTreeText(processor.runSync(processor.parse(markdown)) as Root);}
const fields={title:z.string().trim().max(120).default(''),body:z.string().max(20000).default(''),category:z.string().trim().max(40).default(''),starred:z.boolean().default(false),style:z.object({bold:z.boolean(),underline:z.boolean(),color:z.enum(noteColors),highlight:z.enum(noteHighlights)}).strict().default(emptyNoteStyle)};
const create=z.object({...fields,groupId:idSchema,kind:z.enum(['note','annotation']),anchor:z.object({messageId:idSchema,start:z.number().int().min(0),end:z.number().int().min(1),quote:z.string().min(1).max(12000)}).strict().optional()}).strict();
const edit=z.object({...fields,expectedRevision:z.number().int().positive()}).strict();
const deletion=z.object({expectedRevision:z.number().int().positive()}).strict();
function meaningful(entry:Pick<NotebookEntry,'kind'|'title'|'body'|'starred'|'style'>){
  if(entry.kind==='note'?!entry.body.trim()&&!entry.title.trim():!entry.body.trim()&&!entry.starred&&!entry.style.bold&&!entry.style.underline&&entry.style.color==='default'&&entry.style.highlight==='none')throw new DiscussionError('请填写笔记，或选择标注样式、收藏、评论。',400);
}
/** Human UI routes only. Never included in model tools, prompts, events or chat exports. */
export function installNotebook(app:FastifyInstance,store:Store){
  app.get('/api/notebook',async request=>{
    const {groupId}=z.object({groupId:idSchema.optional()}).strict().parse(request.query);
    return store.notebookEntries(groupId);
  });
  app.post('/api/notebook',async(request,reply)=>{
    const data=create.parse(request.body);
    if(!store.group(data.groupId))throw new DiscussionError('群聊不存在。',404);
    let anchor:NotebookEntry['anchor'];
    if(data.kind==='annotation'){
      if(!data.anchor)throw new DiscussionError('请选择一条发言中的文字。',400);
      const a=data.anchor,m=store.message(a.messageId);
      if(!m||m.groupId!==data.groupId)throw new DiscussionError('原消息不属于此群聊。',400);
      if(m.status==='streaming')throw new DiscussionError('请等待这条消息生成完成后标注。',409);
      const text=messageNotebookText(m.content);
      if(a.end<=a.start||a.end>text.length||text.slice(a.start,a.end)!==a.quote||!a.quote.trim())throw new DiscussionError('选中文字与原消息不一致，请重新选择。',400);
      anchor={...a,author:m.author};
    }else if(data.anchor)throw new DiscussionError('独立笔记不能附带发言标注。',400);
    meaningful(data);
    if(store.notebookCount()>=20000||store.notebookEntries(data.groupId).length>=2000)throw new DiscussionError('笔记数量已达上限，请先整理旧条目。',409);
    const now=new Date().toISOString(),entry:NotebookEntry={...data,anchor,id:randomUUID(),revision:1,createdAt:now,updatedAt:now};
    store.saveNotebookEntry(entry);return reply.code(201).send(entry);
  });
  app.put<{Params:{id:string}}>('/api/notebook/:id',async request=>{
    const data=edit.parse(request.body),entry=store.notebookEntry(idSchema.parse(request.params.id));
    if(!entry)throw new DiscussionError('笔记不存在。',404);
    if(data.expectedRevision!==entry.revision)throw new DiscussionError('这条笔记已被其他窗口修改。请刷新列表后重新编辑。',409);
    const {expectedRevision,...fields}=data,updated={...entry,...fields,revision:entry.revision+1,updatedAt:new Date().toISOString()};meaningful(updated);store.saveNotebookEntry(updated);return updated;
  });
  app.delete<{Params:{id:string}}>('/api/notebook/:id',async request=>{
    const data=deletion.parse(request.body),entry=store.notebookEntry(idSchema.parse(request.params.id));
    if(!entry)throw new DiscussionError('笔记不存在。',404);
    if(data.expectedRevision!==entry.revision)throw new DiscussionError('这条笔记已被修改，请刷新后重试。',409);
    store.deleteNotebookEntry(entry.id);return {ok:true};
  });
}
