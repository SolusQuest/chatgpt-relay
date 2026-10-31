export interface LifecycleRecord { tabId?: number; session: string; conversationId?: string | null; projectId?: string | null; lifecyclePolicy?: 'protected' | 'reclaimable'; provenance?: 'relay' | 'manual'; lastTaskActivityAt?: number; [key:string]: any }
export interface PageManagerDependencies {
  storageGet(key:string): Promise<any>;
  storageSet(key:string,value:any): Promise<void>;
  listTabs(): Promise<Array<{id?:number; active?:boolean; pinned?:boolean}>>;
  getPageState(tabId:number): Promise<any>;
  inspectSession(session:string): Promise<any>;
  listPending(): Promise<any>;
  closePage(record:LifecycleRecord & {tabId:number},state:any): Promise<any>;
  now?(): number;
}
export function createPageManager(dependencies:PageManagerDependencies): {
  remember(tabId:number,metadata:LifecycleRecord,isCurrent?:()=>boolean): Promise<void>;
  forget(tabId:number,isCurrent?:()=>boolean): Promise<void>;
  noteActivity(session:string): Promise<void>;
  setPolicy(tabId:number,policy:'protected'|'reclaimable'): Promise<void>;
  capacity(maxManagedTabs?:number): Promise<{managedCount:number;maxManagedTabs:number;available:number}>;
  withSlot<T>(openFn:()=>Promise<T> | T,maxManagedTabs?:number): Promise<T>;
};
