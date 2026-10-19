export interface QuotaWindow {usedPercent:number;windowDurationMins:number|null;resetsAt:number|null;}
export interface SubscriptionQuota {id:string;name:string;model?:string;primary:QuotaWindow|null;secondary:QuotaWindow|null;}
export interface SubscriptionStatus {connected:boolean;plan?:string;email?:string;pending:boolean;quotas:SubscriptionQuota[];checkedAt?:string;error?:string;}
