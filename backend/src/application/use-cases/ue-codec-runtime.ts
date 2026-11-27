import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { constants } from 'fs';
import type { SpeechCodec } from './ue-audio-codecs';

const execute=promisify(execFile);
let cachedTools:{at:number;value:{ffmpeg:boolean;amr:boolean;amrWb:boolean;evs:boolean}}|undefined;
export const codecDirectory=()=>process.env.UE_CODEC_DIR || path.resolve(process.cwd(),'data/ue-codecs');
export async function codecTools(force=false){
 if(!force && cachedTools && Date.now()-cachedTools.at<15000)return cachedTools.value;
 let decoders='';
 try{decoders=(await execute('ffmpeg',['-hide_banner','-decoders'],{timeout:5000,maxBuffer:1024*1024})).stdout;}catch{/* Optional until installation. */}
 let evs=false;
 try{await fs.access(path.join(codecDirectory(),'EVS_dec'),constants.X_OK);evs=true;}catch{/* Optional until installation. */}
 const value={ffmpeg:!!decoders,amr:/\bamrnb\b/.test(decoders),amrWb:/\bamrwb\b/.test(decoders),evs};cachedTools={at:Date.now(),value};return value;
}
// Capture/SDP output can contain SDES keys. Never pass it through command logging.
export async function readAudioCapture(args:string[]){
 try{const result=await execute('tshark',args,{timeout:20000,maxBuffer:100*1024*1024});return {...result,exitCode:0};}
 catch(error:any){return {stdout:String(error.stdout??''),stderr:String(error.stderr??'Audio capture decoding failed'),exitCode:1};}
}
export async function decodeSpeech(codec:SpeechCodec,input:Buffer):Promise<{pcm:Buffer;sampleRate:number}> {
 const directory=await fs.mkdtemp(path.join(tmpdir(),'nms-audio-'));
 try{
  const source=path.join(directory,'speech'),output=path.join(directory,'pcm');
  await fs.writeFile(source,input,{mode:0o600});
  const sampleRate=codec==='AMR'?8000:codec==='AMR-WB'?16000:48000;
  const command=codec==='EVS'?path.join(codecDirectory(),'EVS_dec'):'ffmpeg';
  const args=codec==='EVS'?['-mime','-q','-no_delay_cmp','48',source,output]:['-hide_banner','-loglevel','error','-f','amr','-i',source,'-ac','1','-ar',String(sampleRate),'-f','s16le',output];
  try{await execute(command,args,{timeout:15000,maxBuffer:1024*1024});}
  catch{throw new Error('The '+codec+' decoder could not decode this payload. Verify the codec and RTP format, then check/install the audio tools.');}
  const stat=await fs.stat(output);if(stat.size>2*48000*12)throw new Error('Audio output exceeds the bounded playback window');
  return {pcm:await fs.readFile(output),sampleRate};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
