import type {ProviderConfig} from '../shared/types';
import {hasHostedPrice} from '../shared/hosted-models';

export function ModelSharing({provider,selected,change,disabled}:{provider:ProviderConfig;selected:string[];change:(models:string[])=>void;disabled:boolean}) {
  const models=[...new Set([...Object.keys(provider.modelPrices??{}),provider.model,...selected])].filter(Boolean);
  return <fieldset className="model-sharing" disabled={disabled}>
    <legend>向网站会员开放的模型</legend>
    <p className="field-help">可同时开放多个模型，默认模型不影响其他已开放模型。先在上方选择模型并填写输入、输出单价，再勾选并保存连接。全部取消则停止共享此连接。</p>
    {models.map(model=>{const priced=hasHostedPrice(provider,model);return <label key={model} className="model-sharing-choice">
      <input type="checkbox" checked={selected.includes(model)} disabled={!priced&&!selected.includes(model)} onChange={e=>change(e.target.checked?[...selected,model]:selected.filter(id=>id!==model))}/>
      <span>{model}{!priced&&<small> · 请先配置有效单价</small>}</span>
    </label>;})}
    <p className="field-help">只公开模型信息，不公开密钥。停用连接后，相关形象会从会员可选列表中隐藏；已有聊天记录保留。</p>
  </fieldset>;
}
