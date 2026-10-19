/** A local estimate, not a vendor tokenizer. Byte length is a payload bound, not token usage. */
export function estimateTokens(text:string):number {
  let units=0;
  for(const char of text){const cp=char.codePointAt(0)!;units+=cp<128?0.35:cp>=0x2e80&&cp<=0x9fff?1.5:2;}
  return Math.ceil(units*1.15)+256;
}
