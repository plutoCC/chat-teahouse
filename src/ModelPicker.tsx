import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { connectionKey, type ProviderConfig } from '../shared/types';
import { referenceCatalog, type ModelCatalog } from '../shared/model-catalog';

export type CatalogLoader = (id: string, region: 'cn' | 'intl', refresh?: boolean) => Promise<ModelCatalog>;
export function ModelPicker({ provider, value, change, load, label, disabled = false, revision = 0 }: {provider:ProviderConfig;value:string;change:(value:string)=>void;load:CatalogLoader;label:string;disabled?:boolean;revision?:number}) {
  const [catalog,setCatalog]=useState<ModelCatalog>(()=>provider.billingMode==='subscription'?{providerId:provider.id,region:provider.region,source:'account',models:[],message:'请先完成官方 ChatGPT 登录，再刷新订阅模型列表。'}:referenceCatalog(provider));
  const [query,setQuery]=useState('');const [advanced,setAdvanced]=useState(false);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
  const serial=useRef(0);
  const refresh=useCallback(async(force=false)=>{
    const request=++serial.current;setLoading(true);setError('');
    try {const result=await load(connectionKey(provider),provider.region,force);if(request===serial.current)setCatalog(result);}
    catch(e){if(request===serial.current)setError(e instanceof Error?e.message:'模型列表读取失败');}
    finally{if(request===serial.current)setLoading(false);}
  },[load,provider.id,provider.connectionId,provider.region,provider.hasKey,provider.billingMode,revision]);
  useEffect(()=>{void refresh();return()=>{serial.current++;};},[refresh]);
  const visible=catalog.models.filter(m=>m.id===value||`${m.label} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const known=catalog.models.some(m=>m.id===value);
  const source=catalog.source==='account'?'官方账号列表':catalog.source==='local'?'本机已下载模型':catalog.source==='demo'?'本地演示选项':'官方文档参考列表';
  return <div className="model-picker">
    <label className="field"><span>{label}</span><select aria-label={label} required disabled={disabled||advanced} value={value} onChange={e=>change(e.target.value)}>
      {!value&&<option value="" disabled>请选择模型</option>}
      {!!value&&!known&&<option value={value}>{value} · 当前值，尚未在本次列表中确认</option>}
      {visible.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
    </select></label>
    <div className="model-picker-actions"><input aria-label="筛选模型选项" type="search" placeholder="筛选模型选项…" value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)}/><button type="button" className="secondary-button" disabled={loading||disabled} onClick={()=>void refresh(true)}>{loading?<LoaderCircle size={13} className="spinning"/>:<RefreshCw size={13}/>}刷新列表</button></div>
    <small className="model-catalog-source">{source} · {catalog.models.length} 个候选{catalog.partial?' · 部分列表':''}{catalog.fetchedAt?` · ${new Date(catalog.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 更新`:catalog.checkedAt?` · ${catalog.checkedAt} 整理`:''}</small>
    <p className="field-help">{catalog.message} {catalog.sourceUrl&&<a href={catalog.sourceUrl} target="_blank" rel="noopener noreferrer">查看官方目录</a>}</p>
    {!visible.length&&<p className="field-help">没有匹配的选项，请清空筛选或刷新列表。</p>}
    {error&&<p className="inline-error" role="status">{error}</p>}
    {provider.id!=='demo'&&<><label className="model-picker-advanced"><input type="checkbox" checked={advanced} disabled={disabled} onChange={e=>setAdvanced(e.target.checked)}/>高级：手动填写模型 ID</label>{advanced&&<label className="field"><span>自定义模型 ID</span><input aria-label="自定义模型 ID" required disabled={disabled} maxLength={128} value={value} onChange={e=>change(e.target.value)}/><small>仅用于未列出的专用部署或接入点；请从官方控制台复制准确 ID。</small></label>}</>}
  </div>;
}
