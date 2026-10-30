import { args, main } from '../src/io.mjs';
import { runPipeline } from '../src/pipeline.mjs';
await main(async()=>{
  const a=args({
    config:{type:'string'},source:{type:'string'},target:{type:'string'},
    glossary:{type:'string'},reviews:{type:'string'},resolutions:{type:'string'},out:{type:'string'},synthetic:{type:'boolean',default:false}
  },['config','source','target','glossary','out']);
  const result=await runPipeline({...a,configPath:a.config});
  console.log(result.evidence.status+': '+result.evidencePath);
  if(result.evidence.warning) console.log(result.evidence.warning);
});
