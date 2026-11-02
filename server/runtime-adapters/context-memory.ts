import {existsSync,lstatSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().min(1).refine(s=>Buffer.byteLength(s)<=12_000);
const entry=z.discriminatedUnion('kind',[
  z.object({key:hash,kind:z.literal('checkpoint'),start:z.number().int().nonnegative(),end:z.number().int().positive(),signature:hash,text}).strict(),
  z.object({key:hash,kind:z.literal('chunks'),next:z.number().int().positive(),text}).strict(),
]);
type MemoryEntry=z.infer<typeof entry>;
/** Private bounded memory; source logs remain authoritative and are never rewritten. */
export class ContextMemory {
  private entries=new Map<string,MemoryEntry>();
  private path?:string;
  constructor(dataDir?:string,filename='context-memory.json'){
    if(!dataDir)return;
    this.path=join(dataDir,filename);
    if(existsSync(this.path)){
      const stat=lstatSync(this.path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2_000_000)return;
      try{const parsed=z.object({version:z.literal(1),entries:z.array(entry).max(128)}).strict().parse(JSON.parse(readFileSync(this.path,'utf8')));this.entries=new Map(parsed.entries.map(e=>[`${e.kind}:${e.key}`,e]));}catch{/* Rebuild invalid derived memory from original history. */}
    }
  }
  get(key:string,kind:MemoryEntry['kind']){return this.entries.get(`${kind}:${key}`);}
  clear(){this.entries.clear();}
  put(value:MemoryEntry){
    entry.parse(value);const key=`${value.kind}:${value.key}`,unchanged=JSON.stringify(this.entries.get(key))===JSON.stringify(value);this.entries.delete(key);this.entries.set(key,value);
    while(this.entries.size>64)this.entries.delete(this.entries.keys().next().value!);
    if(!this.path||unchanged)return;
    const temp=this.path+'.tmp';
    for(const path of [this.path,temp])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Unsafe context memory path');
    writeFileSync(temp,JSON.stringify({version:1,entries:[...this.entries.values()]}),{mode:0o600});renameSync(temp,this.path);
  }
}
