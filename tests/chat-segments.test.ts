import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChatMessage } from '../server/room-engine/segments.js';
import { hasGratuitousPraise, PEER_GROUP_RULES } from '../server/discussion-protocol.js';
import {readingSeconds,segmentDelayMs} from '../server/room-engine/pacing.js';

test('reading pace keeps the 1-second baseline, counts Unicode text, and bounds long blocks',()=>{
  assert.equal(segmentDelayMs('中'.repeat(100),20),5000);
  assert.equal(segmentDelayMs('中'.repeat(100),0),1000);
  assert.equal(segmentDelayMs('短句',20),1000);
  assert.equal(readingSeconds('😀'.repeat(100),20),5);
  assert.equal(readingSeconds('  字  ',1),1);
  assert.equal(segmentDelayMs('中'.repeat(8000),1),90000);
});

test('chat splitting uses paragraphs then sentence boundaries and does not lose content or split graphemes',()=>{
  assert.deepEqual(splitChatMessage('第一段。\n\n第二段。\r\n\r\n第三段。'),['第一段。','第二段。','第三段。']);
  const long=('先看资源的来源，再判断短期风险。这个前提尚未得到证明，不能直接接受。').repeat(20)+'👨‍👩‍👧‍👦'.repeat(40);
  const parts=splitChatMessage(long);assert.ok(parts.length>3);assert.equal(parts.join(''),long);
  for(const part of parts){assert.ok(Array.from(part).length<=220);assert.ok(!part.startsWith('\u200d')&&!part.endsWith('\u200d'));}
  assert.deepEqual(splitChatMessage(''),['']);assert.deepEqual(splitChatMessage('简短判断。'),['简短判断。']);
});

test('chat splitting keeps fenced code, tables, links and emphasized phrases intact',()=>{
  const code='```ts\n'+('const sample = 1;\n'.repeat(30))+'```';
  const table='| 前提 | 证据 |\n| --- | --- |\n'+('| 需要核对 | 未证实 |\n'.repeat(25)).trim();
  const link='[来源](https://example.com/'+('a'.repeat(260))+')';
  const strong='**'+('完整强调内容'.repeat(12))+'**';
  const text=`开场判断。\n\n${code}\n\n${table}\n\n${link} ${'先考虑限制。'.repeat(40)}${strong}`;
  const parts=splitChatMessage(text);assert.ok(parts.includes(code));assert.ok(parts.includes(table));assert.ok(parts.some(s=>s.includes(link)));assert.ok(parts.some(s=>s.includes(strong)));
  assert.equal(parts.join('').replace(/\s/g,''),text.replace(/\s/g,''));
});

test('peer charter enforces independence without requiring disagreement; praise guard permits reasoned agreement and quotes',()=>{
  assert.match(PEER_GROUP_RULES,/不规定每次必须反对/);assert.match(PEER_GROUP_RULES,/明确指出哪条新依据/);assert.match(PEER_GROUP_RULES,/身份、语气和票数不是证据/);
  for(const s of ['你说得太对了！接着说。','我觉得你这个修正特别到位——我赞同。','@豆包，你的观点太精辟了。','好问题！我们继续。','你这个分析非常精准。'])assert.equal(hasGratuitousPraise(s),true,s);
  for(const s of ['我赞同“需要缓冲期”，因为随机抽牌不能直接决定生死。','这个观点成立的条件是资源可替换。','我不接受这个反例，因为它改变了原来的前提。','我保留之前的判断，但要缩小适用范围。','> 你说得太对了。','“你说得太对了”是我们应避免的套话。','数据不充分，暂时无法判断。'])assert.equal(hasGratuitousPraise(s),false,s);
});
