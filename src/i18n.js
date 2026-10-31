// Interface text in English and Korean. The language comes from the main
// menu's switch (remembered in this browser), else Korean. t(key, params) fills in {name}-style placeholders. Text the
// host sends to everyone (feed messages) goes as a key and its values, so
// each player reads it in their own language.

const STRINGS = {
  en: {
    'menu.language': 'Language',
    'menu.name': 'Name',
    'menu.namePlaceholder': 'Player',
    'menu.mode': 'Mode (when hosting)',
    'mode.limit': 'Default: up to {n} hacks per life',
    'mode.any': 'No limit: any number of hacks',
    'menu.host': 'Host Game',
    'menu.codePlaceholder': 'ROOM CODE',
    'menu.join': 'Join',

    'status.loading': 'Loading models…',
    'status.loadFailed': 'Could not load models: {error}',
    'status.creating': 'Creating room…',
    'status.hostFailed': 'Could not host: {error}',
    'status.noCode': 'Could not get a free room code, try again',
    'status.enterCode': 'Enter a 5-character room code',
    'status.connecting': 'Connecting…',
    'status.invited': 'Invited to room {code}: enter your name and press Join',
    'status.disconnected': 'Disconnected from host',
    'status.lost': 'Lost connection to host',
    'net.roomNotFound': 'Room not found',
    'net.signalTimeout': 'Timed out reaching the signaling server',
    'net.noAnswer': 'The host didn\'t respond. Is the host tab still open on the game screen?',
    'net.noDirect': 'Found the host, but the browsers couldn\'t open a direct connection. '
      + 'Testing on one computer? Open the game via http://localhost:8080 in both browsers. '
      + 'A VPN or firewall may block direct connections; try with it off, or add a TURN server in src/config.js.',
    'net.failed': 'Could not connect to host (ICE state: {state})',

    'room.hosting': 'Hosting · Room code: {code} · share this page\'s link with friends',
    'room.joined': 'Room {code}',
    'room.limit': 'Up to {n} hacks',
    'room.noLimit': 'No limit',
    'room.team': 'You are {team}',

    'hud.reloading': 'Reloading…',
    'hud.clickToPlay': 'Click to play',
    'hud.killedBy': 'Killed by {name}',
    'hud.headshot': 'headshot',
    'hud.died': 'You died',
    'hud.respawning': 'Respawning…',
    'hud.respawningIn': 'Respawning in {s}',
    'hud.protection': 'Spawn protection {s}',
    'hud.eliminated': 'Eliminated {name}',
    'hud.someone': 'someone',

    'board.team': 'Team',
    'board.player': 'Player',
    'board.kills': 'Kills',
    'board.money': 'Money',
    'board.hacks': 'Hacks',

    'feed.soundOff': 'Sound off (M)',
    'feed.soundOn': 'Sound on (M)',
    'feed.killReward': '+${n} for the kill',
    'feed.pickedUp': 'Picked up {weapon}',
    'feed.cash': '+${n}',
    'feed.healed': 'Healed',
    'feed.joined': '{name} joined {team}',
    'feed.left': '{name} left',
    'feed.kill': '{killer} ➜ {victim}',
    'feed.killHeadshot': '{killer} ➜ {victim} (headshot)',
    'feed.victory': '{name} hacked the game: {team} wins!',
    'feed.noBots': 'Bots unavailable on this map',

    'buy.title': 'Choose your loadout',
    'buy.weapon': 'Weapon',
    'buy.hacks': 'Hacks',
    'buy.upTo': '(up to {n})',
    'buy.anyNumber': '(any number)',
    'buy.survived': 'Survived {s} s: +${n}',
    'buy.newRoundLimit': 'New round! Pick a weapon and up to {n} hacks.',
    'buy.newRoundAny': 'New round! Pick a weapon and any hacks.',
    'buy.startLimit': 'Pick a weapon and up to {n} hacks to start with.',
    'buy.startAny': 'Pick a weapon and any hacks to start with.',
    'buy.free': 'Free',
    'buy.total': 'Total ${n}',
    'buy.start': 'Start',
    'buy.startIn': 'Start in {s}',
    'buy.spawning': 'Spawning…',
    'buy.bots': 'Bots (AI players): fill teams to',
    'buy.botsOff': 'Off',
    'help': 'WASD move · Space jump · Ctrl crouch · Mouse aim · Click shoot · R reload · M mute · Tab scores · Esc release mouse',

    'victory.wins': '{team} wins!',
    'victory.by': '{name} bought the Victory hack',
    'victory.next': 'Next round in {s}',

    'team.0': 'Blue',
    'team.1': 'Red',

    'weapon.pistol': 'Pistol',
    'weapon.revolver': 'Revolver',
    'weapon.rifle': 'Rifle',
    'weapon.p90': 'P90',
    'weapon.shotgun': 'Shotgun',
    'weapon.sniper': 'Sniper',

    'hack.map': 'Map hack',
    'hack.map.short': 'Map',
    'hack.map.desc': 'Minimap: every player and pickup timer',
    'hack.speed': 'Speed hack',
    'hack.speed.short': 'Speed',
    'hack.speed.desc': 'Move 3x faster',
    'hack.recoil': 'Recoil hack',
    'hack.recoil.short': 'Recoil',
    'hack.recoil.desc': '85% less spread',
    'hack.ammo': 'Infinite ammo hack',
    'hack.ammo.short': 'Infinite ammo',
    'hack.ammo.desc': 'No reloads; faster shotgun and sniper',
    'hack.noclip': 'No-clip hack',
    'hack.noclip.short': 'No-clip',
    'hack.noclip.desc': 'Walk through walls and ceilings',
    'hack.fly': 'Fly hack',
    'hack.fly.short': 'Fly',
    'hack.fly.desc': 'Q up, E down (up to 25 m); a bit faster',
    'hack.wall': 'Wall hack',
    'hack.wall.short': 'Wall',
    'hack.wall.desc': 'See players and hitboxes through walls',
    'hack.hp': 'HP hack',
    'hack.hp.short': 'HP',
    'hack.hp.desc': '1500 HP',
    'hack.aim': 'Aim hack',
    'hack.aim.short': 'Aim',
    'hack.aim.desc': 'Hold Shift: lock onto a visible head',
    'hack.victory': 'Victory hack',
    'hack.victory.short': 'Victory',
    'hack.victory.desc': 'Your team wins the round',
  },

  ko: {
    'menu.language': '언어',
    'menu.name': '이름',
    'menu.namePlaceholder': '플레이어',
    'menu.mode': '모드 (방을 만들 때)',
    'mode.limit': '기본: 목숨당 핵 최대 {n}개',
    'mode.any': '제한 없음: 핵 개수 무제한',
    'menu.host': '방 만들기',
    'menu.codePlaceholder': '방 코드',
    'menu.join': '참가',

    'status.loading': '모델 불러오는 중…',
    'status.loadFailed': '모델을 불러오지 못했습니다: {error}',
    'status.creating': '방 만드는 중…',
    'status.hostFailed': '방을 만들 수 없습니다: {error}',
    'status.noCode': '빈 방 코드를 찾지 못했습니다. 다시 시도해 주세요',
    'status.enterCode': '5자리 방 코드를 입력하세요',
    'status.connecting': '연결 중…',
    'status.invited': '{code} 방에 초대되었습니다: 이름을 입력하고 참가를 누르세요',
    'status.disconnected': '호스트와 연결이 끊어졌습니다',
    'status.lost': '호스트의 응답이 없어 연결이 끊어졌습니다',
    'net.roomNotFound': '방을 찾을 수 없습니다',
    'net.signalTimeout': '시그널링 서버에 연결하는 데 시간이 초과되었습니다',
    'net.noAnswer': '호스트가 응답하지 않습니다. 호스트의 탭이 게임 화면에 열려 있나요?',
    'net.noDirect': '호스트를 찾았지만 브라우저끼리 직접 연결하지 못했습니다. '
      + '한 컴퓨터에서 테스트 중이라면 두 브라우저 모두 http://localhost:8080 으로 접속하세요. '
      + 'VPN이나 방화벽이 직접 연결을 막을 수 있습니다. 끄고 다시 시도하거나 src/config.js 에 TURN 서버를 추가하세요.',
    'net.failed': '호스트에 연결할 수 없습니다 (ICE 상태: {state})',

    'room.hosting': '방장 · 방 코드: {code} · 이 페이지 링크를 친구에게 공유하세요',
    'room.joined': '방 {code}',
    'room.limit': '핵 최대 {n}개',
    'room.noLimit': '핵 제한 없음',
    'room.team': '{team} 팀',

    'hud.reloading': '재장전 중…',
    'hud.clickToPlay': '클릭해서 플레이',
    'hud.killedBy': '{name}에게 처치됨',
    'hud.headshot': '헤드샷',
    'hud.died': '사망했습니다',
    'hud.respawning': '부활 중…',
    'hud.respawningIn': '{s}초 후 부활',
    'hud.protection': '스폰 보호 {s}',
    'hud.eliminated': '{name} 처치',
    'hud.someone': '누군가',

    'board.team': '팀',
    'board.player': '플레이어',
    'board.kills': '킬',
    'board.money': '돈',
    'board.hacks': '핵',

    'feed.soundOff': '소리 끔 (M)',
    'feed.soundOn': '소리 켬 (M)',
    'feed.killReward': '처치 보상 +${n}',
    'feed.pickedUp': '{weapon} 획득',
    'feed.cash': '+${n}',
    'feed.healed': '체력 회복',
    'feed.joined': '{name}님이 {team} 팀에 참가했습니다',
    'feed.left': '{name}님이 나갔습니다',
    'feed.kill': '{killer} ➜ {victim}',
    'feed.killHeadshot': '{killer} ➜ {victim} (헤드샷)',
    'feed.victory': '{name}님이 게임을 해킹했습니다: {team} 팀 승리!',
    'feed.noBots': '이 맵에서는 봇을 사용할 수 없습니다',

    'buy.title': '장비 선택',
    'buy.weapon': '무기',
    'buy.hacks': '핵',
    'buy.upTo': '(최대 {n}개)',
    'buy.anyNumber': '(개수 제한 없음)',
    'buy.survived': '{s}초 생존: +${n}',
    'buy.newRoundLimit': '새 라운드! 무기와 핵(최대 {n}개)을 고르세요.',
    'buy.newRoundAny': '새 라운드! 무기와 핵(개수 제한 없음)을 고르세요.',
    'buy.startLimit': '시작할 무기와 핵(최대 {n}개)을 고르세요.',
    'buy.startAny': '시작할 무기와 핵(개수 제한 없음)을 고르세요.',
    'buy.free': '무료',
    'buy.total': '합계 ${n}',
    'buy.start': '시작',
    'buy.startIn': '{s}초 후 시작',
    'buy.spawning': '스폰 중…',
    'buy.bots': '봇(AI 플레이어): 팀 인원 채우기',
    'buy.botsOff': '끄기',
    'help': 'WASD 이동 · Space 점프 · Ctrl 앉기 · 마우스 조준 · 클릭 사격 · R 재장전 · M 음소거 · Tab 점수판 · Esc 마우스 해제',

    'victory.wins': '{team} 팀 승리!',
    'victory.by': '{name}님이 승리 핵을 구매했습니다',
    'victory.next': '{s}초 후 다음 라운드',

    'team.0': '블루',
    'team.1': '레드',

    'weapon.pistol': '권총',
    'weapon.revolver': '리볼버',
    'weapon.rifle': '소총',
    'weapon.p90': 'P90',
    'weapon.shotgun': '샷건',
    'weapon.sniper': '저격총',

    'hack.map': '맵핵',
    'hack.map.short': '맵핵',
    'hack.map.desc': '미니맵: 모든 플레이어와 아이템 타이머',
    'hack.speed': '스피드핵',
    'hack.speed.short': '스피드',
    'hack.speed.desc': '이동 속도 3배',
    'hack.recoil': '무반동 핵',
    'hack.recoil.short': '무반동',
    'hack.recoil.desc': '탄 퍼짐 85% 감소',
    'hack.ammo': '무한 탄약 핵',
    'hack.ammo.short': '무한 탄약',
    'hack.ammo.desc': '재장전 없음, 샷건·저격총 연사 속도 증가',
    'hack.noclip': '벽 통과 핵',
    'hack.noclip.short': '벽 통과',
    'hack.noclip.desc': '벽과 천장을 통과',
    'hack.fly': '플라이핵',
    'hack.fly.short': '플라이',
    'hack.fly.desc': 'Q 상승, E 하강 (최대 25 m), 조금 더 빠름',
    'hack.wall': '월핵',
    'hack.wall.short': '월핵',
    'hack.wall.desc': '벽 너머로 플레이어와 히트박스가 보임',
    'hack.hp': '체력 핵',
    'hack.hp.short': '체력',
    'hack.hp.desc': '체력 1500',
    'hack.aim': '에임핵',
    'hack.aim.short': '에임',
    'hack.aim.desc': 'Shift 누르기: 보이는 적의 머리에 조준 고정',
    'hack.victory': '승리 핵',
    'hack.victory.short': '승리',
    'hack.victory.desc': '우리 팀이 라운드 승리',
  },
};

export const LANGUAGES = { en: 'English', ko: '한국어' };

function initialLang() {
  try {
    const saved = localStorage.getItem('hackfps.lang');
    if (saved in STRINGS) return saved;
  } catch { /* (storage blocked) */ }
  return 'ko';
}

export let lang = initialLang();

export function setLang(next) {
  if (!(next in STRINGS)) return;
  lang = next;
  try { localStorage.setItem('hackfps.lang', next); } catch { /* (storage blocked) */ }
}

// The text for key in the current language (English if missing there),
// with {placeholders} filled in from params.
export function t(key, params = {}) {
  const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export const teamName = (team) => t(`team.${team}`);
export const weaponName = (weapon) => t(`weapon.${weapon.id}`);
export const hackName = (hack) => t(`hack.${hack.id}`);
export const hackShort = (hack) => t(`hack.${hack.id}.short`);
export const hackDesc = (hack) => t(`hack.${hack.id}.desc`);

// Fixed page text: elements marked data-i18n (text) / data-i18n-placeholder.
export function applyPageText(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
