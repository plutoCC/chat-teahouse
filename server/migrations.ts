import { Store } from './store.js';
import { profileParticipant } from '../shared/types.js';
import { defaultFreeSettings } from '../shared/free-chat.js';

/** Old relay identities are retained as disabled browser seats, never silently dispatched. */
export function migrateChatFeatures(store:Store) {
  store.atomic(()=>{
    for(const p of store.providers())if(!p.modelPrices)store.saveProvider({...p,modelPrices:{[p.model]:{inputPrice:p.inputPrice,outputPrice:p.outputPrice}}});
    const converted=new Set<string>();
    for(const p of store.profiles(true))if((p.channel as string)==='web') {
      store.saveProfile({...p,channel:'browser',revision:p.revision+1});converted.add(p.id);
    }
    for(const g of store.groups()) {
      let changed=false;
      g.participants=g.participants.map(p=>{
        if(p.profileId&&converted.has(p.profileId)){changed=true;return profileParticipant(store.profile(p.profileId)!,p.id,false);}
        if((p.channel as string)==='web'){changed=true;return {...p,channel:'browser',enabled:false};}return p;
      });
      // One-time switch requested for existing rooms; subsequent user choices are preserved.
      if(g.freeSettings?.messageStyle===undefined){g.freeSettings={...defaultFreeSettings,...g.freeSettings,messageStyle:'segmented',messageGapMin:1,messageGapMax:3,readingCharsPerSecond:0,typingGraceSeconds:2,quietSeconds:1,cooldownMin:2,cooldownMax:5};changed=true;}
      else if(g.freeSettings.messageGapMin===undefined){g.freeSettings={...defaultFreeSettings,...g.freeSettings};changed=true;}
      if(changed)store.saveGroup(g);
    }
  });
}
