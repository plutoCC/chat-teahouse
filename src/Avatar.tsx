import { useState } from 'react';

export function Avatar({person,size=''}:{person:{avatar:string;avatarAssetId?:string;color:string;name?:string;author?:string};size?:string}) {
  const [failed,setFailed]=useState<string>();
  const id=person.avatarAssetId;
  const showImage=id&&/^[a-f0-9]{64}$/.test(id)&&failed!==id;
  return <span className={`avatar ${size}`} style={{backgroundColor:/^#[0-9a-f]{3,8}$/i.test(person.color)?person.color:'#34705a'}}>
    {showImage?<img src={`/api/avatars/${id}`} alt={`${person.name||person.author||'成员'}的头像`} onError={()=>setFailed(id)}/>:person.avatar||'AI'}
  </span>;
}
