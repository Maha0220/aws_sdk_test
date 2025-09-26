import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { setAwsVpc, create3TierRds } from "./aws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, "play-data.json");

// 초기 JSON 구조
const initialConfig = {
  vpcId: null,
  publicSubnets: null,
  privateSubnets: null,
  dbSubnets: null,
  type: null,
  webIp: null,
  appIp: null,
  dbEndpoint: null,
  s3Address: null,
  lbAddress: null,
  diagram: null,
};

// 파일 존재 확인 및 생성
function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initialConfig, null, 2));
  }
}

// Getter: 설정 불러오기
export function getConfig() {
  ensureConfigFile();
  const data = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(data);
}

// Setter: 설정 갱신
export function setConfig(updates) {
  ensureConfigFile();
  const current = getConfig();
  const newConfig = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
  return newConfig;
}

// ===== JSON 스토리 로드 =====
const storyPath = path.join(__dirname, "story.json");
const story = JSON.parse(fs.readFileSync(storyPath, "utf-8"));

// ===== ASCII 아트 로드 =====
function loadAscii(name) {
  try {
    const asciiPath = path.join(__dirname, "ascii", `${name}.txt`);
    return fs.readFileSync(asciiPath, "utf-8");
  } catch {
    return "";
  }
}

// ===== readline 설정 =====
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ===== 액션 정의 =====
const actions = {
  playAnimation: async () => {
    console.clear();
    console.log(loadAscii("cat"));
    await new Promise(r => setTimeout(r, 600));
    console.clear();
    console.log(loadAscii("cat2"));
    await new Promise(r => setTimeout(r, 600));
  },
  feedSnack: async () => {
    console.clear();
    console.log(loadAscii("cat"));
    console.log("\n🍪 고양이에게 간식을 줬다!");
    setConfig({ snackGiven: true });
    await new Promise(r => setTimeout(r, 800));
  },
  setAwsVpc: async () => {
    console.clear();
    console.log(loadAscii("cat"));
    if(getConfig().vpcId) {
      console.log("\n✅ 이미 VPC가 설정되어 있습니다!");
      await new Promise(r => setTimeout(r, 800));
      return
    }
    const vpc =  await setAwsVpc();
    console.log("\n✅ VPC 설정 완료!");
    setConfig(vpc);
    await new Promise(r => setTimeout(r, 1600));
  },
  setAws3TierRds: async () => {
    console.clear();
    console.log(loadAscii("cat"));
    if(getConfig().type) {
      console.log("\n✅ 이미 아키텍쳐가 설정되어 있습니다!");
      await new Promise(r => setTimeout(r, 800));
      return
    }
    const art = await create3TierRds(getConfig());
    console.log("\n✅ 3-Tier RDS 아키텍처 설정 완료!");
    setConfig(art);
    await new Promise(r => setTimeout(r, 3600));
  }
};

// ===== 게임 루프 =====
async function play(sceneKey) {
  const scene = story[sceneKey];
  console.clear();

  // ASCII 아트
  if (scene.ascii) {
    console.log(loadAscii(scene.ascii));
  } else {
    console.log(loadAscii("cat"));
  }

  // 장면 텍스트
  console.log(scene.text);

  // 엔딩 표시
  if (scene.ending) {
    console.log(`=== ${scene.ending} END ===`);
  }

  // 선택지가 없으면 종료
  if (!scene.options || scene.options.length === 0) {
    rl.close();
    await new Promise(r => setTimeout(r, 1600));
    console.clear();
    return;
  }

  //vpc 표시
  if (sceneKey === "main" && getConfig().vpcId) {
    const cfg = getConfig();
    console.log(`현재 VPC ID: ${cfg.vpcId}`);
    if (cfg.type) {
      console.log(`구성된 인프라: ${cfg.type}`);
      console.log(cfg.diagram);
    }
    // console.log(`퍼블릭 서브넷: ${cfg.publicSubnets}`);
    // console.log(`프라이빗 서브넷: ${cfg.privateSubnets}`);
    // console.log(`DB 서브넷: ${cfg.dbSubnets}`);
    console.log(`--------------------------------`);
    // 선택지 출력
    scene.options.forEach(opt => console.log(`${opt.key}. ${opt.text}`));
  } else if (sceneKey === "main") {
    console.log(``) 
    console.log(`현재 VPC가 설정되어 있지 않습니다.`);
    //0번 옵션 말고 제외
    console.log(`--------------------------------`);
    // 선택지 출력
    scene.options?.filter(opt => opt.action === "setAwsVpc")?.forEach(opt => console.log(`${opt.key}. ${opt.text}`));
  } else {
    console.log(`--------------------------------`);
    // 선택지 출력
    scene.options.forEach(opt => console.log(`${opt.key}. ${opt.text}`));
  }

  rl.question("\n선택: ", async (answer) => {
    const option = scene.options.find(opt => opt.key === answer);
    if (option) {
      if (option.action && actions[option.action]) {
        await actions[option.action]();
      }
      play(option.next);
    } else {
      console.log("❌ 잘못된 선택이야!");
      setTimeout(() => play(sceneKey), 1000);
    }
  });
}

// ===== 게임 시작 =====
console.clear();
play("start");