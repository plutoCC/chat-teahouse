import type {ProviderId} from './types.js';

export interface BillingCapability {credential:'model-key'|'access-key'|'admin-key'|'none';title:string;description:string;docs:string;}
export const BILLING_CAPABILITIES:Record<ProviderId,BillingCapability>={
  deepseek:{credential:'model-key',title:'DeepSeek 账户余额',description:'使用此连接已保存的 API Key，查询所属账户的余额、赠送余额和充值余额。账户可能还被其他应用使用，余额变化不等于本群费用。',docs:'https://api-docs.deepseek.com/api/get-user-balance/'},
  doubao:{credential:'access-key',title:'火山引擎余额与账单',description:'需要火山引擎 AccessKey ID / SecretAccessKey 的费用中心查询权限，方舟模型 API Key 不能查询财务。余额属于整个云账户；账单仅汇总可识别的火山方舟产品记录，可能延迟更新。请确认凭据属于模型所用账户。',docs:'https://docs.volcengine.com/docs/BillingCenter/QueryBalanceAcct-Queryuseraccountbalanceinformation?lang=zh'},
  qwen:{credential:'access-key',title:'阿里云账户余额',description:'需要阿里云 AccessKey ID / Secret 和 QueryAccountBalance 查询权限（bss:DescribeAcccount）。DashScope 模型 API Key 不能查询财务。返回整个阿里云账户的余额，包含其他云产品；请确认凭据所属账户。',docs:'https://help.aliyun.com/en/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance'},
  openai:{credential:'admin-key',title:'OpenAI 官方组织费用',description:'需要单独的组织 Admin API Key，普通模型 API Key 不适用。官方 Costs 接口提供组织费用，不提供预付剩余余额；包含该组织其他应用的开销，不是本群账单。',docs:'https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs'},
  claude:{credential:'admin-key',title:'Claude 官方组织费用',description:'需要单独的 Claude Console Admin API Key。返回组织的官方费用报告，不提供剩余余额，也不是 Claude 网页订阅额度；部分服务（例如 Priority Tier）不在此报告范围内。',docs:'https://platform.claude.com/docs/en/manage-claude/usage-cost-api'},
  ollama:{credential:'none',title:'本地 Ollama',description:'本地模型没有云端余额接口；本机运行成本未计入。',docs:'https://docs.ollama.com/'},
  demo:{credential:'none',title:'本地演示',description:'演示模式不调用付费模型，没有账户余额。',docs:''}
};
export interface BillingMoney {label:string;amount:string;currency:string;kind:'balance'|'cost';scope:'account'|'organization'|'ark';period?:string;partial?:boolean;}
export interface BillingStatus {configured:boolean;state:'unconfigured'|'unverified'|'ready'|'partial'|'error'|'unsupported';metrics:BillingMoney[];checkedAt?:string;retrievedAt?:string;month?:string;error?:string;warnings:string[];}
export type BillingCredentials={accessKeyId:string;secretAccessKey:string;site?:'cn'|'intl'}|{adminKey:string};
