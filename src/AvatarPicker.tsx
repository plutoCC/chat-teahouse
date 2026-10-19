import { useRef, useState } from 'react';

export type AvatarUploader = (file: File) => Promise<string>;
export function avatarFileData(file: File): Promise<string> {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onerror=()=>reject(new Error('无法读取图片，请重新选择。'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);
  });
}
export function AvatarPicker({value,change,upload,pending}:{value?:string;change:(id?:string)=>void;upload:AvatarUploader;pending:(value:boolean)=>void}) {
  const input=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const select=async(file?:File)=>{
    if(!file)return;
    setError('');
    if(file.size>2*1024*1024){setError('头像图片不能超过 2 MB。');return;}
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){setError('请选择 PNG、JPG、WebP 或 GIF 图片。');return;}
    setBusy(true);pending(true);
    try{change(await upload(file));}catch(e){setError(e instanceof Error?e.message:'上传失败，请重试。');}
    finally{setBusy(false);pending(false);}
  };
  return <div className="avatar-picker">
    <div className="avatar-picker-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'正在处理图片…':value?'更换图片头像':'上传图片头像'}</button>
      {value&&<button type="button" className="text-button" disabled={busy} onClick={()=>{change(undefined);setError('');}}>使用文字头像</button>}
    </div>
    <input ref={input} type="file" aria-label="选择头像图片" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';void select(file);}}/>
    <small className="field-help">PNG / JPG / WebP / GIF，最大 2 MB。居中裁切为方形，动图取首帧；图片仅保存在本机。保存成员后生效。</small>
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </div>;
}
