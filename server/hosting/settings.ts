import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultHostingSettings,normalizeHostingSettings,type HostingSettings,type HostingSettingsSnapshot} from '../../shared/hosting-settings.js';

export class HostingSettingsError extends Error {}
function rejectLinks(path:string){for(let cursor=path;;cursor=dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new HostingSettingsError('分享设置路径不能使用符号链接。');if(cursor===dirname(cursor))break;}}
/** One owner-only file, atomic replacement, live reads, and optimistic versioning across manager windows. */
export class HostingSettingsStore {
  private readonly path:string;
  private readonly initial:HostingSettings;
  constructor(dataDir:string,initial:Partial<HostingSettings>={}){
    this.path=join(resolve(dataDir),'hosting-settings.json');rejectLinks(this.path);
    this.initial=normalizeHostingSettings(initial);mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
  }
  snapshot():HostingSettingsSnapshot {
    rejectLinks(this.path);
    if(!existsSync(this.path))return {version:0,values:{...this.initial}};
    try{
      if(!lstatSync(this.path).isFile()||lstatSync(this.path).size>32768)throw new Error();
      const value=JSON.parse(readFileSync(this.path,'utf8'));
      if(value.format!=='chat-teahouse-settings-v1'||!Number.isSafeInteger(value.version)||value.version<1)throw new Error();
      return {version:value.version,values:normalizeHostingSettings(value.values)};
    }catch{throw new HostingSettingsError('分享设置文件无效，已停止使用此设置；请在本机检查并修复。');}
  }
  values():HostingSettings{return this.snapshot().values;}
  update(values:unknown,expectedVersion:number):HostingSettingsSnapshot{
    let normalized:HostingSettings;try{normalized=normalizeHostingSettings(values);}catch(error){throw new HostingSettingsError(error instanceof Error?error.message:'分享设置无效。');}
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new HostingSettingsError('设置版本无效，请重新加载后保存。');
    const lock=this.path+'.lock';rejectLinks(lock);
    let descriptor:number;try{descriptor=openSync(lock,'wx',0o600);}catch{throw new HostingSettingsError('另一个窗口正在保存设置，请稍后刷新后再试。');}
    const temporary=this.path+'.'+randomUUID()+'.tmp';
    try{
      const current=this.snapshot();
      if(current.version!==expectedVersion)throw new HostingSettingsError('分享设置已在另一个窗口修改，请重新加载后再保存。');
      const next={version:current.version+1,values:normalized};
      writeFileSync(temporary,JSON.stringify({format:'chat-teahouse-settings-v1',...next},null,2)+'\n',{mode:0o600,flag:'wx'});
      renameSync(temporary,this.path);return next;
    }finally{if(existsSync(temporary))unlinkSync(temporary);closeSync(descriptor);unlinkSync(lock);}
  }
}
