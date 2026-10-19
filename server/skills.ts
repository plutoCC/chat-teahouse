import type { SkillDefinition } from '../shared/free-chat.js';
import { Store } from './store.js';
import { DiscussionError } from './scheduler.js';

const builtins: SkillDefinition[] = [
  {id:'argument-check',name:'论证检查',description:'检查命题的前提、证据和推论，保留有依据的异议。',instructions:'先识别正在讨论的具体主张，再区分事实、假设和推论。检查证据是否支持结论，指出最关键的缺口和可证伪条件。可以赞同，也可以有理由地反对；不要为了扮演反对者而反对。引用群内消息 ID；没有检索工具时不得声称已经查证。只公开对当前讨论有帮助的内容。',builtin:true},
  {id:'compare-options',name:'方案比较',description:'按共同约束比较候选方案，说明取舍及待验证条件。',instructions:'从群聊中提取真实提出过的候选方案和约束，用相同标准比较收益、实现成本和可逆性。未知数据标明未知，不编造数字。若需要额外信息，向讨论者提出一个具体问题。不要自动把用户或多数人的偏好当作最终决定。',builtin:true},
  {id:'discussion-notes',name:'讨论纪要',description:'按消息来源整理共识、分歧和待验证事项。',instructions:'按当前群消息整理已获得支持的共识、仍在争议的观点、未证实的假设和可选行动。每项关键判断引用消息 ID。保留少数意见，不将讨论记录改写成用户已经批准的执行命令。没有足够新内容时可以不发言。',builtin:true},
];
export function seedSkills(store: Store) { for(const skill of builtins)if(!store.skill(skill.id))store.saveSkill(skill); }
export function skillSummaries(store: Store) { return store.skills().map(({instructions,...summary})=>summary); }

/** Instruction-only import. No archive extraction, paths, scripts, dependencies or YAML evaluation. */
export function importInstructionSkill(store: Store, markdown: string): SkillDefinition {
  const match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(markdown);
  if(!match)throw new DiscussionError('SKILL.md 需要以 --- 包围的 name、description 元数据和正文。');
  const field=(key:string)=>{
    const raw=new RegExp(`^${key}:\\s*(.+)$`,'m').exec(match[1])?.[1].trim()??'';
    return raw.replace(/^(["'])(.*)\1$/,'$2');
  };
  const id=field('name'),description=field('description');
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||!description||description.length>400||/^[>|&*!]/.test(description))throw new DiscussionError('name 应为英文小写短横线名称；description 请使用不超过 400 字的单行文本。');
  if(store.skill(id))throw new DiscussionError('已有同名技能，请使用其他名称。',409);
  if(store.skills().length>=60)throw new DiscussionError('技能数量已达上限。');
  const skill:SkillDefinition={id,name:id,description,instructions:match[2].trim(),builtin:false};
  if(!skill.instructions)throw new DiscussionError('技能正文不能为空。');
  store.saveSkill(skill);return skill;
}
