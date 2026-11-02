import {resolve} from 'node:path';
import {HostingAccounts,HostingAccountError} from '../server/hosting/accounts.js';
import {SecretVault} from '../server/vault.js';
import {hostingDataDir} from '../server/hosting/config.js';

// A local-only management command. Access codes are never accepted in argv,
// logged to a file, or returned by list. Send each code privately to its user.
const args=process.argv.slice(2),flag=args.indexOf('--data-dir');
let directory=process.env.CHAT_TEA_HOST_DATA_DIR??'data-hosted';
if(flag>=0){directory=args[flag+1];args.splice(flag,2);}
if(!directory||!['add','list','revoke','code','reset-code'].includes(args[0])||(args[0]==='list'?args.length!==1:args.length!==2)){
  console.error('用法：npm run host:user -- --data-dir <分享专用目录> add <名字> | list | code <账号ID> | reset-code <账号ID> | revoke <账号ID>');process.exitCode=1;
}else{
  let accounts:HostingAccounts|undefined;
  try{
    const dataDir=hostingDataDir(resolve(directory));
    new SecretVault(dataDir);
    accounts=new HostingAccounts(dataDir);
    if(args[0]==='add'){
      const {user,code}=accounts.add(args[1]);
      console.log(`账号：${user.name}\nID：${user.id}\n访问码（已加密保存，可在分享助手再次查看）：${code}\n请通过私密渠道交给本人，不要发布到群聊、截图或仓库。`);
    }else if(args[0]==='list'){
      for(const user of accounts.list())console.log(`${user.id}\t${user.name}\t${user.revokedAt?'已撤销':'有效'}\t${user.createdAt}`);
    }else if(args[0]==='code'){
      const code=accounts.recoverCode(args[1]);
      if(!code)throw new HostingAccountError('旧邀请码未保存可恢复副本。请在分享助手导入原码或重置新码。');
      console.log(`访问码：${code}\n请通过私密渠道交给本人。`);
    }else if(args[0]==='reset-code'){
      const {code}=accounts.resetCode(args[1]);console.log(`新访问码：${code}\n旧码与旧登录会话失效，聊天记录保留。`);
    }else{
      if(!/^[a-f0-9-]{36}$/.test(args[1])||!accounts.revoke(args[1]))throw new HostingAccountError('账号不存在。');
      console.log('访问已撤销。登录会话即刻失效，已打开的实时连接最多 30 秒内断开；聊天数据保留。');
    }
  }catch(e){console.error(e instanceof HostingAccountError?e.message:'账号管理未完成。请检查专用数据目录及文件权限。');process.exitCode=1;}
  finally{accounts?.close();}
}
