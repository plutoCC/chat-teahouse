import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, ExternalLink } from 'lucide-react';
import type { ProviderConfig } from '../shared/types';
import { PRICE_CHECKED_AT, PRICE_SOURCES, cnyToUsd, displayNumber, estimateCny, formatCny, referenceFor, toCny, validExchangeRate } from '../shared/pricing';
import { setExchangeRate, useExchangeRate } from './currency';
import './pricing.css';

function PriceHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null), panel = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState({ above: false, height: 450 });
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = anchor.current?.closest('dialog');
    const position = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect(), bounds = dialog?.getBoundingClientRect();
      const above = rect.top - Math.max(12, bounds?.top ?? 0) - 8;
      const below = Math.min(window.innerHeight - 12, bounds?.bottom ?? window.innerHeight) - rect.bottom - 8;
      const useAbove = panel.current.scrollHeight > below && above > below;
      const next = { above: useAbove, height: Math.max(80, Math.floor(useAbove ? above : below)) };
      setPlacement(old => old.above === next.above && old.height === next.height ? old : next);
    };
    position(); window.addEventListener('resize', position); dialog?.addEventListener('scroll', position);
    return () => { window.removeEventListener('resize', position); dialog?.removeEventListener('scroll', position); };
  }, [open, children]);
  return <span ref={anchor} className="price-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={e => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="price-help-button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={() => setOpen(true)} onClick={e => { if (e.detail > 0) setOpen(true); else setOpen(v => !v); }}><CircleHelp size={15}/></button>
    {open && <span ref={panel} id={id} role="tooltip" className={`price-tooltip${placement.above ? ' above' : ''}`} style={{ maxHeight: placement.height }}>{children}</span>}
  </span>;
}

export function BudgetField({ valueUSD, change }: { valueUSD: number; change: (usd: number) => void }) {
  const fx = useExchangeRate(); const id = useId();
  return <div className="field price-field"><div className="price-label"><label htmlFor={id}>费用预算（人民币）</label><PriceHelp label="费用预算说明"><b>本次讨论的估算总费用上限</b><span>按模型连接中保存的单价估算；输入和输出都计费。填 0 关闭金额保护。</span><span>按 1 美元 ≈ {fx} 元显示，可在模型连接中修改估算汇率；不是实时汇率。</span><span>已有预算的美元金额保持不变。实际费用以供应商账单为准。</span></PriceHelp></div><input id={id} type="number" required min="0" max={1000 * fx} step="any" value={displayNumber(valueUSD * fx)} onChange={e => change(cnyToUsd(Math.max(0, Number(e.target.value)), fx))}/></div>;
}

export function ModelPricing({ provider, inputUSD, outputUSD, change, disabled }: {
  provider: Pick<ProviderConfig, 'id' | 'model' | 'region'>; inputUSD: number; outputUSD: number;
  change: (input: number, output: number) => void; disabled: boolean;
}) {
  const fx = useExchangeRate();
  const reference = referenceFor(provider);
  const [selected, setSelected] = useState(0);
  const [basis, setBasis] = useState<'reference' | 'configured'>('reference');
  const [inputMillions, setInputMillions] = useState('1');
  const [outputMillions, setOutputMillions] = useState('1');
  const [fxDraft, setFxDraft] = useState(String(fx));
  const [notice, setNotice] = useState('');
  const inputId = useId(), outputId = useId();
  const price = reference?.tiers[selected] ?? reference?.tiers[0];
  const input = toCny(inputUSD, 'USD', fx), output = toCny(outputUSD, 'USD', fx);
  const refInput = reference && price ? toCny(price.input, reference.currency, fx) : undefined;
  const refOutput = reference && price ? toCny(price.output, reference.currency, fx) : undefined;
  const useReference = basis === 'reference' && refInput !== undefined && refOutput !== undefined;
  const cost = inputMillions.trim() && outputMillions.trim() ? estimateCny(Number(inputMillions), Number(outputMillions), useReference ? refInput! : input, useReference ? refOutput! : output) : null;
  const source = reference?.source ?? PRICE_SOURCES[provider.id];
  const local = provider.id === 'demo' || provider.id === 'ollama';
  const tip = (direction: '输入' | '输出', referenceRate: number | undefined, configuredRate: number) => <>
    <b>{provider.model || '未填写模型'} · {direction}参考价格</b>
    {referenceRate === undefined ? <span>暂无此模型的已核实报价，请按官方账单手动填写。接入点 ID 无法推断对应模型，未配置价格不表示免费。</span> : <><span>{price?.label}</span><strong>{formatCny(referenceRate)} / 百万 Token</strong><span>0.1 百万 ≈ {formatCny(referenceRate * 0.1)}<br/>1 百万 ≈ {formatCny(referenceRate)}<br/>10 百万 ≈ {formatCny(referenceRate * 10)}</span><span>{reference?.currency === 'USD' ? `美元报价 × ${fx} 估算换算；非实时汇率。` : '官方人民币报价，参考价无需汇率换算。'}</span></>}
    <span>当前填写单价：{formatCny(configuredRate)} / 百万 Token。</span><span>这里填写单价；任意用量可在下方试算。输入含历史上下文，输出含供应商计费的思考 Token。</span><small>参考核对：{PRICE_CHECKED_AT} · 实际以账单为准</small>
  </>;
  return <section className="model-pricing" aria-label="模型价格与人民币试算">
    <div className="pricing-heading"><strong>模型单价</strong><small>人民币 / 百万 Token</small></div>
    <div className="form-grid">
      <div className="field price-field"><div className="price-label"><label htmlFor={inputId}>输入单价</label><PriceHelp label="输入参考价格说明">{tip('输入', refInput, input)}</PriceHelp></div><input id={inputId} type="number" min="0" max={10000 * fx} step="any" required disabled={disabled || local} value={displayNumber(input)} onChange={e => change(cnyToUsd(Math.max(0, Number(e.target.value)), fx), outputUSD)}/></div>
      <div className="field price-field"><div className="price-label"><label htmlFor={outputId}>输出单价</label><PriceHelp label="输出参考价格说明">{tip('输出', refOutput, output)}</PriceHelp></div><input id={outputId} type="number" min="0" max={10000 * fx} step="any" required disabled={disabled || local} value={displayNumber(output)} onChange={e => change(inputUSD, cnyToUsd(Math.max(0, Number(e.target.value)), fx))}/></div>
    </div>
    <div className="reference-rate">
      {reference && price ? <>
        {reference.tiers.length > 1 ? <label className="field"><span>参考价格档位</span><select value={selected} onChange={e => setSelected(Number(e.target.value))}>{reference.tiers.map((p, i) => <option value={i} key={p.label}>{p.label}</option>)}</select></label> : <span>{price.label}</span>}
        <p>参考：输入 <b>{formatCny(refInput!)}</b> · 输出 <b>{formatCny(refOutput!)}</b> / 百万 Token</p>
        <small>{reference.note}</small>
        {!local && <button type="button" className="text-button" disabled={disabled} onClick={() => { change(reference.currency === 'USD' ? price.input : cnyToUsd(price.input, fx), reference.currency === 'USD' ? price.output : cnyToUsd(price.output, fx)); setNotice('参考单价已填入，请点击「保存连接」生效。'); }}>采用此参考单价</button>}
      </> : <p>暂无此模型的已核实报价，请手动填写单价。自定义模型和接入点不会套用其他模型的价格。</p>}
      {source && <a href={source} target="_blank" rel="noreferrer">官方价格 <ExternalLink size={12}/><small>核对于 {PRICE_CHECKED_AT}</small></a>}
      {notice && <p className="pricing-notice" role="status">{notice}</p>}
    </div>
    <details className="price-calculator" open>
      <summary>人民币费用试算</summary>
      <label className="field"><span>试算依据</span><select value={useReference ? 'reference' : 'configured'} onChange={e => setBasis(e.target.value as 'reference' | 'configured')}><option value="reference" disabled={!reference}>当前模型参考价</option><option value="configured">当前填写的单价（含未保存修改）</option></select></label>
      <div className="form-grid"><label className="field"><span>输入用量（百万 Token）</span><input type="number" min="0" max="1000000" step="any" value={inputMillions} onChange={e => setInputMillions(e.target.value)}/></label><label className="field"><span>输出用量（百万 Token）</span><input type="number" min="0" max="1000000" step="any" value={outputMillions} onChange={e => setOutputMillions(e.target.value)}/></label></div>
      <output aria-live="polite" className="price-total" aria-label="人民币试算结果"><span>输入 {cost ? formatCny(cost.input) : '—'} ＋ 输出 {cost ? formatCny(cost.output) : '—'}</span><strong>合计约 {cost ? formatCny(cost.total) : '—'}</strong></output>
      {!local && !useReference && (input === 0 || output === 0) && <p className="pricing-notice">有单价为 0，试算可能低估费用；0 不代表云端模型免费。</p>}
      <small>填 1 = 100 万 Token，0.1 = 10 万。这里是累计用量，不代表单条请求的上下文长度；档位请按实际单次请求选择。仅试算，不调用模型。</small>
    </details>
    <details className="exchange-settings"><summary>估算汇率：1 美元 ≈ {fx} 元（可修改）</summary><label className="field"><span>人民币 / 美元（非实时）</span><input type="number" min="0.01" max="100" step="any" value={fxDraft} onChange={e => setFxDraft(e.target.value)} onBlur={() => { const next = Number(fxDraft); if (validExchangeRate(next)) setExchangeRate(next); else setFxDraft(String(fx)); }}/></label><small>离开输入框后生效，仅在本浏览器保存。默认 7 是试算假设；已有美元计价记录和预算保持不变，人民币显示随汇率变化。</small></details>
    <p className="pricing-footnote">不含缓存优惠、批量折扣、免费额度及额外工具费用。费率按连接和模型分别保存。这里仅编辑上方选中模型的价格；其他模型不会套用它的单价。未填写的模型会标记费用不完整，启用金额保护时拒绝调用。</p>
  </section>;
}
