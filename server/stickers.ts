import sharp from 'sharp';
import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { DiscussionError } from './scheduler.js';

const title=z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/);
export const stickerMetadataSchema=z.object({name:title,tags:z.array(title).max(8)}).strict();
export const stickerUploadSchema=stickerMetadataSchema.extend({data:z.string().min(4).max(5592408).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(s=>s.length%4===0)}).strict();
export class StickerLibrary {
  private processing=0;
  constructor(private store:Store){}
  async upload(data:z.infer<typeof stickerUploadSchema>){
    const bytes=Buffer.from(data.data,'base64');if(bytes.length>4*1024*1024)throw new DiscussionError('表情包最大 4 MB。');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    const gif=['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
    const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!png&&!jpeg&&!gif&&!webp)throw new DiscussionError('仅支持 PNG、JPG、WebP 和 GIF 图片。');
    if(this.processing>=2)throw new DiscussionError('正在处理图片，请稍后再试。',429);
    this.processing++;
    try{
      let result:Buffer;
      try{
        const meta=await sharp(bytes,{limitInputPixels:16_000_000}).metadata();
        if((meta.pages??1)>100||!meta.width||!meta.height||meta.width*(meta.pageHeight??meta.height)*(meta.pages??1)>16_000_000)throw Error('limit');
        result=await sharp(bytes,{animated:true,limitInputPixels:16_000_000,failOn:'warning'}).rotate().resize(320,320,{fit:'inside',withoutEnlargement:true}).webp({quality:80}).timeout({seconds:10}).toBuffer();
        if(result.length>4*1024*1024)throw Error('output limit');
      }catch{throw new DiscussionError('图片无法读取或过大；最多 100 帧、总计 1600 万像素。');}
      return this.store.atomic(()=>{
        if(this.store.stickers(true).length>=200)throw new DiscussionError('表情库最多保留 200 个表情（含已删除记录）。');
        const assetId=createHash('sha256').update(result).digest('hex');
        if(!this.store.stickerAsset(assetId)){
          if(this.store.stickerStorageBytes()+result.length>256*1024*1024)throw new DiscussionError('表情包本机存储已达 256 MB 上限。');
          this.store.saveStickerAsset(assetId,result);
        }
        const sticker={id:randomUUID(),assetId,name:data.name,tags:[...new Set(data.tags)],createdAt:new Date().toISOString()};this.store.saveSticker(sticker);return sticker;
      });
    }finally{this.processing--;}
  }
}
