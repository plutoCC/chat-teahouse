import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const rootFiles=new Set(['.gitignore','.gitattributes','.editorconfig','.env.example','LICENSE','README.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','Start-Teahouse.cmd','Start-Teahouse.ps1','Launch-Teahouse.cmd','Stop-Teahouse.cmd']);
const screenshots=new Set(['docs/images/demo.png','docs/images/demo-mentions.png']);
const docs=new Set(['docs/DEPLOYMENT.md','docs/USER-GUIDE.md','docs/ARCHITECTURE.md','docs/TESTING.md',...screenshots]);
export interface Finding {path:string;line?:number;reason:string;}
export function inspectPublicFile(path:string,bytes:Buffer,mode='100644'):Finding[] {
  const findings:Finding[]=[],add=(reason:string,line?:number)=>findings.push({path,line,reason});
  const allowed=rootFiles.has(path)||docs.has(path)||/^public\/(?:icon\.svg|manifest\.webmanifest)$/.test(path)||/^(?:src|shared|server|tests)\/[\w./-]+\.(?:ts|tsx|css)$/.test(path)||/^scripts\/[\w-]+\.(?:ps1|ts)$/.test(path)||/^\.github\/[\w./-]+\.(?:yml|yaml|md)$/.test(path);
  if(!allowed||path.split('/').some(p=>p==='..'||p==='.')||/(?:^|\/)(?:data|output|backups|browser-profiles|harness-sessions|agent-workspaces|codex-subscription|service-logs|node_modules|dist|\.test-artifacts)(?:\/|$)/i.test(path))add('File is outside the public source allowlist');
  if(!['100644','100755'].includes(mode))add('Symlinks, submodules and unresolved index entries are not publishable');
  if(bytes.length>1024*1024)add('File exceeds the 1 MiB source limit; review it explicitly');
  if(screenshots.has(path)){
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))add('Expected a reviewed PNG demo screenshot');
    return findings;
  }
  if(bytes.includes(0)){add('Unexpected binary content in a source file');return findings;}
  const patterns:[string,RegExp][]=[
    ['Possible API credential',/\b(?:sk-(?:proj-)?[A-Za-z0-9_]{24,}|sk-ant-api\d+-[A-Za-z0-9_-]{40,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{30,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,})\b/],
    ['Private key material',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['Possible bearer session token',/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
    ['Literal private Harness session ID',/\btea-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ['Personal home path',/(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n"' <>]+|\/(?:Users|home)\/[^/\s"'<>]+)/i],
  ];
  const lines=bytes.toString('utf8').split(/\r?\n/);
  lines.forEach((line,i)=>{for(const [reason,pattern] of patterns)if(pattern.test(line))add(reason,i+1);});
  return findings;
}

function main(){
  const git=(args:string[])=>execFileSync('git',args,{maxBuffer:16*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let entries:string[];
  try{entries=git(['ls-files','--stage','-z']).toString('utf8').split('\0').filter(Boolean);}catch{throw new Error('Run this check in a Git working copy after staging the intended public files.');}
  if(!entries.length)throw new Error('No staged/tracked files to inspect.');
  const findings:Finding[]=[];
  for(const entry of entries){
    const match=/^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/.exec(entry);
    if(!match)throw new Error('Unable to inspect the Git index.');
    const [,mode,object,stage,path]=match;
    if(stage!=='0'){findings.push({path,reason:'Unresolved merge stage'});continue;}
    if(!['100644','100755'].includes(mode)){findings.push({path,reason:'Non-regular tracked file'});continue;}
    findings.push(...inspectPublicFile(path,git(['cat-file','blob',object]),mode));
  }
  if(findings.length){for(const f of findings)console.error(`${f.path}${f.line?':'+f.line:''}: ${f.reason}`);process.exitCode=1;}
  else console.log(`Publication check passed: ${entries.length} staged/tracked files. Review new screenshots and unusual content manually.`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(error){console.error(error instanceof Error?error.message:'Publication check failed');process.exitCode=1;}
}
