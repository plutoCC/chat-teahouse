export const noteColors = ['default','red','blue','green','purple'] as const;
export const noteHighlights = ['none','yellow','green','blue','pink'] as const;
export interface NoteStyle { bold:boolean; underline:boolean; color:typeof noteColors[number]; highlight:typeof noteHighlights[number]; }
export const emptyNoteStyle:NoteStyle={bold:false,underline:false,color:'default',highlight:'none'};
export interface NoteAnchor { messageId:string; start:number; end:number; quote:string; author:string; }
export interface NotebookEntry {
  id:string;groupId:string;kind:'note'|'annotation';title:string;body:string;category:string;
  starred:boolean;style:NoteStyle;anchor?:NoteAnchor;revision:number;createdAt:string;updatedAt:string;
}
