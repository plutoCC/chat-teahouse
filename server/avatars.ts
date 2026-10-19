import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { DiscussionError } from './scheduler.js';

const MAX_BYTES = 2 * 1024 * 1024;
/** Accept only raster bytes, never URLs, paths or SVG. Store a new, metadata-free static PNG. */
export class AvatarUploads {
  private processing = 0;
  constructor(private store: Store) {}
  async upload(base64: string) {
    const input = Buffer.from(base64, 'base64');
    if (input.length > MAX_BYTES) throw new DiscussionError('头像图片不能超过 2 MB。', 413);
    const png = input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = input[0] === 255 && input[1] === 216 && input[2] === 255;
    const webp = input.toString('ascii',0,4) === 'RIFF' && input.toString('ascii',8,12) === 'WEBP';
    const gif = ['GIF87a','GIF89a'].includes(input.toString('ascii',0,6));
    if (!png && !jpg && !webp && !gif) throw new DiscussionError('请选择 PNG、JPG、WebP 或 GIF 图片。');
    if (this.processing >= 2) throw new DiscussionError('正在处理头像，请稍后再试。', 429);
    this.processing++;
    try {
      let bytes: Buffer;
      try {
        bytes = await sharp(input, {limitInputPixels:24_000_000,failOn:'warning',pages:1})
          .rotate().resize(256,256,{fit:'cover'}).png().timeout({seconds:10}).toBuffer();
      } catch {
        throw new DiscussionError('图片无法读取或像素过大，请使用完整且不超过 2400 万像素的图片。');
      }
      const id = createHash('sha256').update(bytes).digest('hex');
      this.store.atomic(()=>{
        if (this.store.avatarAsset(id)) return;
        if (this.store.avatarStorageBytes() + bytes.length > 128 * 1024 * 1024) throw new DiscussionError('本机头像存储已达到 128 MB 上限，请复用已有头像。');
        this.store.saveAvatarAsset(id,bytes);
      });
      return {id};
    } finally { this.processing--; }
  }
}
