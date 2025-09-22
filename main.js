import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ===== 애니메이션 프레임 =====
const animFrames = [
  `( o.o )   < 야옹!`,
  `( -.- )   < 눈 깜빡`,
  `( o.o )   < 꼬리 흔드는 중!~~`
];

// ===== 액션 정의 =====
const actions = {
  playAnimation: async () => {
    for (let i = 0; i < 4; i++) { // 4번 반복
      console.clear();
      console.log(animFrames[i % animFrames.length]);
      await new Promise(r => setTimeout(r, 400));
    }
  },
  feedSnack: () => {
    console.log("\n🍪 고양이에게 간식을 줬다!");
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
    return;
  }

  // 선택지 출력
  scene.options.forEach(opt => console.log(`${opt.key}. ${opt.text}`));

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
console.log("=== 3-tier-maker ===");
play("start");
