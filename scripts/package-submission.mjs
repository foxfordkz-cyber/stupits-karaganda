import { parseArgs } from 'node:util';
import { packageSubmission, verifySubmission } from '../src/submission.mjs';

const fields={
  source:'source','original-target':'originalTarget',fixed:'fixed',report:'report',reviews:'reviews',
  glossary:'glossary',html:'html',methodology:'methodology','flutter-evidence':'flutterEvidence',
  'flutter-log':'flutterLog',resolutions:'resolutions',out:'out'
};
try{
  const {values}=parseArgs({strict:true,options:{
    ...Object.fromEntries(Object.keys(fields).map(name=>[name,{type:'string'}])),
    verify:{type:'string'},help:{type:'boolean'}
  }});
  if(values.help){
    console.log('Create: node scripts/package-submission.mjs --source SOURCE --original-target ORIGINAL --fixed FIXED --report REPORT --reviews REVIEWS --glossary CSV --html HTML --methodology MD --flutter-evidence EVIDENCE --flutter-log LOG --out NEW_DIRECTORY [--resolutions FILE]\nVerify: node scripts/package-submission.mjs --verify DIRECTORY\nOnly prepares a local private package. It never uploads artifacts.');
  }else if(values.verify){
    if(Object.keys(fields).some(name=>values[name] !== undefined))throw new Error('--verify cannot be combined with creation options');
    console.log(JSON.stringify(await verifySubmission(values.verify),null,2));
  }else{
    const options=Object.fromEntries(Object.entries(fields).filter(([name])=>values[name] !== undefined).map(([name,key])=>[key,values[name]]));
    const result=await packageSubmission(options);
    console.log(JSON.stringify({status:result.status,directory:result.directory,files:result.files},null,2));
  }
}catch(error){console.error('Submission failed: '+error.message);process.exitCode=1;}
