export class DispatchClient {
  constructor(options: {
    watch(request:{sessions:string[];cursor:string|null;waitMs:number},signal:AbortSignal):Promise<any>;
    membership():Promise<string[]>;
    onSnapshot(snapshot:any):Promise<void>;
    onState?(state:{state:string;lastConnectedAt?:number;lastError:string|null}):void;
    sleep?(ms:number):Promise<void>;
  });
  cursor:string|null;
  stopped:boolean;
  running:Promise<void>|null;
  start():Promise<void>;
  wake():void;
  stop():void;
}
export class RequestPool {
  constructor(limit?:number,backgroundLimit?:number);
  active:number;
  backgroundActive:number;
  run<T>(operation:()=>Promise<T>|T,options?:{background?:boolean;signal?:AbortSignal}):Promise<T>;
}
