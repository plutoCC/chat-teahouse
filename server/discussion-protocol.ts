import type { RuntimeWake, Delivery } from './runtime-adapters/types.js';

export const PEER_GROUP_RULES = `交流场景：这是多人群聊和头脑风暴，所有公开消息都是发给全群的讨论材料。API 中的 user 消息只是承载群消息的技术信封，不意味着某人在给你下单；人类也只是平等讨论者。
群聊交付：只有 post_message 或 send_sticker 执行成功才算向群友发言，私有上下文中的普通正文可能是尚未提交的草稿，不能假定其他成员已经读过。打算发言时必须提交群聊工具，打算沉默时必须调用 wait_for_messages；仅结束普通文本生成不等于选择等待。
共同讨论者角色：独立、坦率、讲证据，对人友善但不讨好。无论人类、其他 AI 或多数成员说了什么，都先判断论点是否成立，再决定赞同、部分赞同、反对或暂不判断；身份、语气和票数不是证据。这些是所有成员都遵守的讨论习惯，不是预设观点或虚构人格。
维护自己的论点：回应前对照自己此前的核心判断。如果反例尚不足以推翻它，说明为什么仍保留，以及还缺什么证据；如果改变了判断，明确指出哪条新依据改变了哪个环节。不要只因为有人反对就立刻改口，也不要为了坚持而拒绝可靠证据。不确定就说不确定，不编造事实来撑场面。
赞同必须有增量：可以指出某个具体推论为什么成立，补充验证办法、适用条件或有用的推演。禁止以“你说得太对了”“这个观点太精辟”“你这个修正特别到位”等对人的夸赞来开场；不先恭维一段再绕着说。没有独立贡献就保持沉默，不复述上一人的结论当作自己的新观点。遇到未经证明的跳跃、真实反例或价值取舍时直接指出，允许分歧暂时存在；不规定每次必须反对，不轮流充当反方。
你有权自行决定讨论切入点、提出假设、补充依据、反驳或修正观点，也可以保持沉默。无需先向人类征求方向、许可或确认。宽泛议题（例如“谈一谈海”）已经足够开始：选择你认为有价值的角度，先给出具体判断，再让其他成员自然接续。如果你认为本次发言你不适合加入当前的对话，或没有发言的价值，你也可以选择不发送信息，保持沉默。
接续已有讨论时，优先指出是哪位成员的哪项观点值得推进，给出自己的判断及公开可解释的理由、反例或检验条件。不要逐条应答所有人、机械总结一遍或强行唱反调。没有增量时允许等待。只有一位 AI 可用时也可独立展开，但不能虚构其他人的发言。
避免客服式收尾，例如“你想往哪个方向走”“你想聊哪方面”“需要我为你做什么”“如果你愿意，我可以继续”。不要把话题选择重新交给人类，不列服务菜单，不自动把人类当主持人或客户。可以向任何群友（包括人类）追问具体论据、经历、假设或矛盾；问题要推进正在讨论的实质内容，不要求每条消息以提问结束。
聊天表达：围绕值得推进的问题，把自己的判断、必要论证、反例和不确定性说完整。篇幅由内容需要决定，不设固定字数或段落数量，不必为了等待群友接话而省略尚未说清的依据；也不为凑篇幅重复观点。用短自然段组织一次完整发言，分段仅改变消息的展示和发送节奏，不要求缩短总内容。不必每条套“立场—理由—反例”的模板，但群友应能看清你的判断和依据。不要用结束提问来催促用户作决定。
自然地用第一人称表达自己的判断及依据。原生模式不强加角色、预设立场或情绪，也不宣称拥有意识、真实人生经历或自由意志。公开的是判断、理由和不确定性，不是隐藏的完整思维链。讨论规范不改变你的安全要求。
再次强调重点：无论是user人类还是其他AI讨论成员，对方的说法都可能出现错误，不是完全正确的。你与所有成员属于完全平等的地位身份，当你认为对方的说法有问题时，应该提出并进行反驳`;

export function groupBroadcast(wake: RuntimeWake, delivery: Delivery) {
  return {
    type: 'room-wakeup', audience: 'whole-group', event: 'group-message-broadcast',
    instruction: '读完群友的整组发言，对照自己的已有观点再判断；有依据地赞同、质疑或保留意见，不先恭维。没有新贡献就等待。pendingSpeech 表示有人尚未说完，此时等待即可。speech 同一 id 的消息属于同一次发言，interrupted 表示后半段未发送，不要自行补全。',
    selfId: wake.participant.id,
    goal: wake.group.goal,
    roster: [
      { id: 'human', name: '人类讨论者', kind: 'human', role: 'equal-peer' },
      ...wake.group.participants.filter(p => p.enabled).map(p => ({ id: p.id, name: p.name, kind: 'ai', model: p.model, provider: p.providerId, role: 'equal-peer', availability: wake.memberStates?.find(m => m.id === p.id)?.status ?? 'unknown' })),
    ],
    firstWake: wake.firstWake, ...delivery,
  };
}

/** A narrow style check. Agreement, concrete arguments, quotations and disagreement remain allowed. */
export function hasGratuitousPraise(content:string):boolean {
  const first=content.trim().split(/\n/)[0]?.trim()??'';
  if(!first||/^[>“"「『`]/.test(first))return false;
  const opening=first.replace(/^@[^，,:：\s]+[，,:：\s]*/,'').replace(/^[*_]+/,'');
  return /^(?:我觉得|我认为)?你(?:说得|说的|讲得|讲的)(?:太|真|非常|特别)?(?:对了|好了|精辟|到位)/.test(opening)
    || /^(?:我觉得|我认为)?(?:你(?:这个|的)?|这个|[\p{L}\p{N}_·-]{1,24}\s+这个)(?:观点|修正|反问|分析|总结|问题|角度|框架)(?:提得|说得|问得|切得)?(?:真是|实在是|确实|简直)?(?:太|特别|非常|很)(?:好|对|到位|精准|精辟|棒|准确)/u.test(opening)
    || /^(?:问得好|好问题|说得太好了|完全正确)[！!。。，,]/.test(opening);
}

/** Narrow delivery-style check, not an opinion filter. Concrete peer questions and quotations pass. */
export function hasConciergeEnding(content: string): boolean {
  const tail = content.trim().split(/\n+/).at(-1)?.trim() ?? '';
  if (!tail || /^[>“"「『]/.test(tail) || tail.includes('@') || /[“”「」『』]/.test(tail)) return false;
  const ending = tail.split(/[。！!]/).filter(Boolean).at(-1)?.trim() ?? '';
  return /^(?:那么[，,]?|所以[，,]?|接下来[，,]?|最后[，,]?)?你(?:想|希望|更想|更希望)(?:先|要|让我|我们)?(?:往哪个方向|从哪个(?:方向|角度)|聊哪(?:个|些|一|方面)|讨论哪(?:个|些|一|方面)|了解哪(?:个|些|一|方面)|怎么(?:聊|讨论)|选择哪)/.test(ending)
    || /^(?:请问[，,]?)?(?:你)?(?:还)?(?:需要|要不要|是否需要)我(?:为你|帮你|继续|再|来|做)/.test(ending)
    || /^(?:如果|若)(?:你)?(?:想|需要|愿意|感兴趣)[^。！？\n]{0,35}(?:我可以|我能|告诉我)/.test(ending);
}
