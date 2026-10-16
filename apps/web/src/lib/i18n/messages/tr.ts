/**
 * The Turkish catalog (T-050): the same keys as en.ts (TypeScript checks it: `Messages`),
 * in friendly, informal Turkish ("sen"). The game terms are in the README's glossary
 * ("Languages"): battle = kapışma, build (the entry) = proje, ship = teslim et, reveal =
 * gösterim, the build step (`npm run build`) stays "build".
 */
import { BUILD_TIME_LIMITS_MINUTES, ROOM_LIMITS } from '@br/game';
import { SITE_LIMITS } from '@br/site';
import type { Messages } from './en';

const MIN_MINUTES = Math.min(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MINUTES = Math.max(...BUILD_TIME_LIMITS_MINUTES);
const MAX_MB = Math.round(SITE_LIMITS.maxPackBytes / (1024 * 1024));
const MAX_FILES = SITE_LIMITS.maxFiles;

const s = String;
const oneDecimal = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const megabytes = (bytes: number) => `${oneDecimal.format(bytes / (1024 * 1024))} MB`;

/** "9 minutes" → "9 dakika" (the server's rate-limit sentence is English). */
const UNITS: Record<string, string> = { second: 'saniye', minute: 'dakika', hour: 'saat' };

export const tr: Messages = {
  language: {
    label: 'Dil',
  },

  common: {
    dismiss: 'Kapat',
    tryAgain: 'Tekrar dene',
    cancel: 'Vazgeç',
    close: 'Kapat',
    ok: 'Tamam',
    home: 'Ana sayfa',
    loading: 'Yükleniyor…',
    loadingBattle: 'Kapışma yükleniyor…',
    you: '(sen)',
    someone: 'Biri',
    host: 'Oda sahibi',
    newTab: '(yeni sekmede açılır)',
    howItWorks: 'Nasıl oynanır',
    yourName: 'Adın',
    anotherName: 'Başka bir rastgele ad',
    myHistory: 'Kapışma geçmişin',
    by: (name) => `Yapan: ${name}`,
    buildOf: (name) => `İsimsiz proje (${name})`,
    screenshotOf: (name) => `Ekran görüntüsü: ${name}`,
    theBuild: 'proje',
    didNotFinish: 'Bitiremedi',
    fullResults: 'Tüm sonuçlar →',
    winner: '🏆 Kazanan',
    roomCode: (code) => `Oda ${code}`,
    buildLabel: (name, builder) => `${name ? `“${name}”` : 'Bir proje'} · Yapan: ${builder}`,
  },

  titles: {
    play: 'Solo oyna',
    try: 'İçe aktarmayı dene',
    guide: 'Nasıl oynanır',
    notFound: 'Sayfa bulunamadı',
  },

  units: {
    minutes: (n) => `${s(n)} dk`,
    seconds: (n) => `${s(n)} sn`,
    files: (n) => `${s(n)} dosya`,
    orList: (items) => new Intl.ListFormat('tr', { type: 'disjunction' }).format(items),
    andList: (items) => new Intl.ListFormat('tr', { type: 'conjunction' }).format(items),
  },

  phases: {
    spinning: 'ÇARK',
    building: 'İNŞA',
    shipping: 'TESLİM',
    reveal: 'GÖSTERİM',
    voting: 'OYLAMA',
    results: 'SONUÇLAR',
    destroyed: 'İMHA',
    abandoned: 'TERK EDİLDİ',
  },

  cards: {
    build: 'PROJE',
    rule: 'KURAL',
    style: 'STİL',
    timeLimit: 'SÜRE',
    timeLimitSr: (t) => `Süre: ${t}`,
  },

  home: {
    title: 'Build Roulette',
    pitch:
      'Vibe coder’lar için bir parti oyunu: aynı görev, kendi yapay zekâ araçların, bambaşka projeler.',
    tryImport: 'İçe aktarmayı dene',
    stepsTitle: 'Bir kapışma nasıl geçer',
    phasesLabel: 'Bir kapışmanın aşamaları',
    guide: 'Rehberin tamamını oku',
    tagline: 'Projeler geçici. Sonuçlar kalıcı.',
    roomsAndSolo: `Bir oda kur ve linki ${s(ROOM_LIMITS.max_players - 1)} arkadaşına (ve ${s(ROOM_LIMITS.max_spectators)} izleyiciye) kadar gönder, ya da tek başına zamana karşı yarış. Hesap gerekmez.`,
    playSolo: 'Solo oyna',
    createRoom: 'Oda kur',
    joinWithCode: 'Kodla katıl',
    creating: 'Kuruluyor…',
    create: 'Kur',
    roomCode: 'Oda kodu',
    join: 'Katıl',
    codeError: 'Oda kodu 5 harf ve rakamdan oluşur, örneğin K7QXM.',
  },

  steps: {
    spin: {
      title: 'Çevir',
      text: `Odadaki herkes aynı rastgele PROJE, KURAL, STİL ve SÜRE kartlarını alır (${s(MIN_MINUTES)} ile ${s(MAX_MINUTES)} dakika arası).`,
    },
    build: {
      title: 'Kendi yolunla yap',
      text: 'Kendi bilgisayarında kendi yapay zekâ aracını kullan: Cursor, Claude Code, Windsurf, Copilot, Lovable, Bolt, v0… ya da düz HTML. Senin prompt’ların, senin numaraların. Oyun bu.',
    },
    drop: {
      title: 'Build al ve bırak',
      text: 'Projenin build’ini al (`npm run build`), sonra `dist` klasörünü (ya da bir .zip) oyuna bırak. İstediğin kadar tekrar bırakabilirsin; süre bitmeden önceki son bırakma sayılır.',
    },
    ship: {
      title: 'Teslim et, izle, oyla',
      text: 'Teslim et. Herkesin projesi tek tek gösterilir, sen oy verirsin ve sonuçlar sonsuza kadar kalır. Projelerin kendisi kapışmadan sonra silinir.',
    },
  },

  stepArt: {
    timeLabel: 'SÜRE',
    terminalResult: '✓ build dist/ içinde hazır',
    dropTarget: '`dist` klasörünü buraya bırak',
    ship: 'Teslim',
    reveal: 'Gösterim',
    vote: 'Oylama',
    results: 'Sonuçlar',
    endNote: 'Projeler silinir · sonuçlar kalır',
  },

  welcome: {
    title: '{brand}’e hoş geldin',
    stepOf: (n, total) => `Adım ${s(n)} / ${s(total)}`,
    steps: 'Adımlar',
    goToStep: (n) => `${s(n)}. adıma git`,
    next: 'İleri',
    back: 'Geri',
    skip: 'Atla',
    practice: 'Önce pratik yap',
    play: 'Hadi oynayalım',
    guide: 'Rehberin tamamını oku',
  },

  lobbyHints: {
    newHereTitle: 'Yeni misin?',
    newHereText:
      'Bir kapışmanın nasıl geçtiğini dört kısa adımda gör, sonra oda sahibi çarkı çevirmeden önce bir içe aktarma denemesi yap.',
    newHereShow: 'Göster',
    newHerePractice: 'İçe aktarma pratiği yap',
    reminder:
      'Projeni kendi bilgisayarında, kendi yapay zekâ aracınla yapacaksın. Oda sahibi çarkı çevirmeden önce aracını aç.',
  },

  phone: {
    guideText:
      'Bu telefonda izler ve oy verirsin. Bir dahaki sefere proje yapmak için bilgisayardan katıl.',
    guideLink: 'Oyun nasıl oynanır',
  },

  importHelp: {
    summary: 'Nasıl içe aktarırım?',
    steps: [
      'Yapay zekâ aracına "production build al" de (ya da `npm run build` komutunu kendin çalıştır).',
      'Build’in oluşturduğu klasörü buraya bırak ya da Klasör seç’e bas. .zip de olur.',
      'Bir şeyi mi değiştirdin? Yeniden build al ve yeniden bırak: son bırakma sayılır.',
    ],
    whereTitle: 'Build’im nerede?',
    where: [
      'Vite (React, Vue, Svelte…) → `dist`',
      'Create React App → `build`',
      "Next.js → `out` (`output: 'export'` gerekir)",
      'Düz HTML → klasörün kendisi',
    ],
    webBuildersTitle: 'Lovable, Bolt, v0 mı?',
    webBuilders:
      'Projeyi .zip olarak indir, zip’i aç, o klasörde `npm install` ve `npm run build` çalıştır, sonra `dist` klasörünü bırak.',
    guide: 'Rehberin tamamı',
    howToFix: 'Bunu nasıl düzeltirim?',
  },

  guide: {
    title: 'Build Roulette nasıl oynanır',
    intro:
      'Herkes aynı rastgele görevi alır. Sen onu kendi bilgisayarında, kendi yapay zekâ araçlarınla yaparsın, build alırsın ve sonucu oyuna bırakırsın. Sonra herkes herkesin projesini görür ve oy verir.',
    home: 'Ana sayfa',
    play: 'Solo oyna',
    practice: 'İçe aktarmayı dene',
    contents: 'Bu sayfada',

    oneMinuteTitle: 'Bir dakikada oyun',

    rulesTitle: 'Siten için kurallar',
    rules: [
      'Tarayıcıda çalışan statik bir site olmalı: HTML, CSS, JavaScript, görseller, fontlar, sesler.',
      'Herkese açık API’leri çağırabilir ve CDN’lerden script yükleyebilir.',
      'Kendi sunucusu ve gizli bilgisi olmaz. İçine asla API anahtarı koyma: build’i alınmış siteyi herkes görebilir.',
      `En fazla ${s(MAX_MB)} MB ve ${s(MAX_FILES)} dosya.`,
      `SÜRE kartı sana ${s(MIN_MINUTES)} ile ${s(MAX_MINUTES)} dakika arası süre verir.`,
      'İstediğin kadar bırakabilirsin. Son içe aktarma sayılır; teslim etmediysen süre bitince senin yerine teslim edilir.',
    ],

    checklistTitle: 'İlk kapışmandan önce',
    checklist: {
      tool: 'Yapay zekâ aracın kurulu ve giriş yapılmış.',
      folder: 'Yeni proje için boş bir klasör.',
      node: 'Aracın bir npm projesi oluşturuyorsa (çoğu öyle yapar) Node.js kurulu:',
      practice: 'Bir içe aktarma pratiği yap:',
    },

    toolsTitle: 'Araç rehberleri',
    toolsIntro: 'Kullandığın araç türünü seç.',
    toolsLabel: 'Araç türü',
    tools: {
      editor: {
        tab: 'Editör ajanları',
        tools: 'Cursor, Windsurf, VS Code + Copilot, Zed',
        steps: [
          'Editöründe boş bir klasör aç.',
          'Ajandan uygulamayı iste: kartları yapıştır, altındaki satırı da ekle.',
          'Çalışınca ajana "production build al" de.',
          '`dist` klasörünü oyuna bırak.',
        ],
      },
      terminal: {
        tab: 'Terminal ajanları',
        tools: 'Claude Code, Codex CLI, Gemini CLI, Aider',
        steps: [
          'Boş bir klasör oluştur ve ajanı onun içinde başlat.',
          'Uygulamayı iste: kartları yapıştır, altındaki satırı da ekle.',
          'Sonuna "bitirince production build al" yaz.',
          '`dist` klasörünü oyuna bırak.',
        ],
      },
      web: {
        tab: 'Web araçları',
        tools: 'Lovable, Bolt, v0, Replit',
        steps: [
          'Uygulamayı her zamanki gibi tarayıcıda yap. Bu araçlar sana build’i alınmış bir site değil, kaynak kod verir.',
          'İndirme / dışa aktarma seçeneğiyle projeyi .zip olarak al ve zip’i aç.',
          'O klasörde bir terminal aç ve önce `npm install`, sonra `npm run build` çalıştır.',
          '`dist` klasörünü oyuna bırak.',
        ],
        note: 'Bunun için bilgisayarında Node.js olmalı. Doğrudan bir linkten içe aktarma ileride geliyor.',
      },
      plain: {
        tab: 'Framework yok',
        tools: 'Düz HTML, CSS ve JavaScript',
        steps: [
          'Bir `index.html` yaz, CSS ve JS dosyaların yanında dursun.',
          'Klasörü bırak. Build gerekmez.',
        ],
      },
    },

    promptTitle: 'Prompt’una ekleyeceğin satır',
    promptIntro:
      'Kartlardan sonra yapıştır, böylece aracın oyunun çalıştırabileceği bir şey yapar:',
    prompt:
      'Tamamen tarayıcıda çalışan statik bir site olsun (sunucu yok, API anahtarı yok). Bitirince production build al.',
    copy: 'Kopyala',
    copied: 'Kopyalandı!',
    copyFailed: 'Kopyalanamadı. Metni seçip kendin kopyala.',

    foldersTitle: 'Build nereye çıkar',
    foldersProject: 'Projen',
    foldersDrop: 'Bu klasörü bırak',
    folders: [
      {
        project: 'Vite (React, Vue, Svelte, Preact, Solid)',
        how: '`npm run build`',
        folder: '`dist/`',
      },
      { project: 'Create React App', how: '`npm run build`', folder: '`build/`' },
      {
        project: 'Next.js',
        how: "next.config’e `output: 'export'` ekle, sonra `npm run build`",
        folder: '`out/`',
      },
      { project: 'Astro', how: '`npm run build`', folder: '`dist/`' },
      { project: 'Nuxt', how: '`npm run generate`', folder: '`.output/public/`' },
      {
        project: 'SvelteKit',
        how: '`adapter-static` kullan, sonra `npm run build`',
        folder: '`build/`',
      },
      { project: 'Angular', how: '`npm run build`', folder: '`dist/<project>/browser/`' },
      { project: 'Düz HTML', how: 'build gerekmez', folder: 'klasörün kendisi' },
    ],
    foldersNote:
      'Proje klasörünün tamamını da bırakabilirsin: oyun içindeki build klasörünü bulur ve `node_modules` klasörünü atlar.',

    troubleTitle: 'Sorun giderme',
    trouble: [
      {
        problem: '"Bu kaynak kod, build’i alınmış site değil"',
        fix: 'Projeyi build almadan bıraktın. `npm run build` çalıştır (ya da yapay zekâ aracına "production build al" de), sonra `dist` klasörünü bırak.',
      },
      {
        problem: '"Next.js statik export ister"',
        fix: "next.config’e `output: 'export'` ekle, yeniden build al ve `out` klasörünü bırak.",
      },
      {
        problem: '"index.html bulunamadı"',
        fix: 'Tek bir dosya değil, build’in oluşturduğu klasörün tamamını bırak.',
      },
      {
        problem: 'Boş bir sayfa',
        fix: 'Önizlemenin altındaki Sorunlar’ı aç: sitenin konsol hataları orada görünür. Onları yapay zekâ aracına yapıştırıp düzeltmesini iste, sonra yeniden build al ve bırak.',
      },
      {
        problem: '"Site çok büyük"',
        fix: `Bir site en fazla ${s(MAX_MB)} MB olabilir. Büyük görselleri ve videoları küçült, sonra yeniden build al.`,
      },
      {
        problem: 'Bir özellik sunucu istiyor (veritabanı, giriş, gizli API anahtarı)',
        fix: 'Tarayıcıda taklit et: veriyi `localStorage` içinde tut, sahte veri kullan ya da anahtar istemeyen herkese açık bir API çağır.',
      },
      {
        problem: 'Firefox gizli penceresinde önizleme hiç başlamıyor',
        fix: 'Firefox’un gizli pencereleri, önizlemenin ihtiyaç duyduğu service worker’ları kapatır. Normal bir pencere kullan.',
      },
    ],

    faqTitle: 'SSS',
    faq: [
      {
        q: 'Projemi kim görür?',
        a: 'Gösterim sırasında odadaki oyuncular ve izleyiciler. Projen kapışmadan sonra silinir; bir ekran görüntüsü ve sonuçlar kalır.',
      },
      {
        q: 'Kapışmadan önce hazırlanabilir miyim?',
        a: 'Kartlar rastgele, yani ne yapacağını bilemezsin. Çark dönmeden önce bir şey yapmak oyunun ruhuna aykırı. Araçlarını hazırlamak ise serbest.',
      },
      {
        q: 'Telefondan oynayabilir miyim?',
        a: 'Telefondan izleyip oy verebilirsin. Proje yapmak için bilgisayar gerekir.',
      },
      {
        q: 'Tek başıma oynayabilir miyim?',
        a: 'Evet: Solo oyna sadece sana bir görev çevirir. Aynı akışla zamana karşı yarış, sonra sonuçlarını gör.',
      },
    ],
    ready: 'Hazır mısın?',
    readyText: 'Önce bir içe aktarma pratiği yap ya da doğrudan oyuna atla.',
  },

  importUi: {
    panelLabel: 'Build’i alınmış siteni içe aktar',
    dropTitle: 'Build’i alınmış siteni buraya bırak',
    dropSub: '`dist` klasörü (ya da proje klasörünün tamamı) veya bir .zip',
    chooseFolder: 'Klasör seç',
    chooseZip: '.zip seç',
    dropOverlay: 'Siteni içe aktarmak için bırak',
    reading: 'Dosyalar okunuyor…',
    restoring: 'Son içe aktarman geri getiriliyor…',
    stepsTitle: 'Üç adımda',
    steps: [
      'Bilgisayarında kendi yapay zekâ aracınla yap.',
      'Build’ini al (`npm run build`) — düz HTML için gerekmez.',
      '`dist` klasörünü buraya bırak.',
    ],
    importAgain: 'Yeniden içe aktar',
    importedFrom: 'İçe aktarılan:',
    droppedFolder: 'bıraktığın klasör',
    locked: 'Bu proje için içe aktarma kapandı.',
    problems: 'Sorunlar',
    console: 'Konsol',
    noProblems: 'Sorun yok.',
    consoleEmpty: 'Sitenin konsol çıktısı burada görünür.',
    clear: 'Temizle',
    skipped: (n) => `${s(n)} dosya atlandı`,
    frameTitle: 'Sitenin önizlemesi',
    loadFailed: 'Siten yüklenemedi',
    couldNotStart: 'Önizleme başlayamadı',
    crashed: 'Önizleme çöktü',
    noAnswer:
      '{url} adresindeki sandbox yanıt vermedi. Bağlantını kontrol et, sonra önizlemeyi yeniden başlat.',
    frozeLoading: (seconds) =>
      `Siten açılışı tamamlayamadı: yüklenirken ${s(seconds)} sn boyunca yanıt vermedi, büyük ihtimalle açılışta çalışan kodda sonsuz bir döngü var. Düzelt, yeniden build al ve içe aktar ya da önizlemeyi yeniden başlat.`,
    froze: (seconds) =>
      `Siten ${s(seconds)} sn boyunca yanıt vermedi, büyük ihtimalle sonsuz bir döngü var. Düzelt, yeniden build al ve içe aktar ya da önizlemeyi yeniden başlat.`,
    restart: 'Önizlemeyi yeniden başlat',
  },

  importErrors: {
    empty: () => ({
      title: 'İçe aktarılacak bir şey yok',
      hint: 'Build’in oluşturduğu klasörü (genelde `dist`) ya da onun .zip’ini bırak.',
    }),
    'no-index': () => ({
      title: 'index.html bulunamadı',
      hint: 'Bir sitenin `index.html` dosyası olmalı. Tek bir dosya değil, build’in oluşturduğu klasörü (genelde `dist`) bırak.',
    }),
    'not-built': () => ({
      title: 'Bu kaynak kod, build’i alınmış site değil',
      hint: 'Önce build al: projende `npm run build` çalıştır (ya da yapay zekâ aracından build almasını iste), sonra oluşan `dist` klasörünü bırak.',
    }),
    'nextjs-not-exported': () => ({
      title: 'Next.js statik export ister',
      hint: "next.config içinde `output: 'export'` ayarla, `npm run build` çalıştır, sonra `out` klasörünü bırak.",
    }),
    'too-many-files': (detail) => ({
      title: 'Çok fazla dosya',
      hint: `Bir sitede en fazla ${s(MAX_FILES)} dosya olabilir${detail ? ` (bunda ${detail} var)` : ''}. node_modules ya da kaynak klasörleri olmadan, sadece build’i alınmış siteyi bırak.`,
    }),
    'too-large': (detail) => ({
      title: 'Site çok büyük',
      hint: `Bir site en fazla ${megabytes(SITE_LIMITS.maxPackBytes)} olabilir${
        detail === undefined ? '' : ` (bu ${megabytes(Number(detail))})`
      }. Büyük görselleri, videoları ya da fontları küçült ve yeniden build al.`,
    }),
    'path-too-long': (detail) => ({
      title: 'Bir dosya yolu çok uzun',
      hint: `Sitedeki yollar en fazla ${s(SITE_LIMITS.maxPathChars)} karakter olabilir${
        detail ? `: ${detail.slice(0, 60)}…` : '.'
      }`,
    }),
    'bad-zip': () => ({
      title: 'Bu .zip okunamadı',
      hint: 'Build klasörünü yeniden zip’le (.rar ya da .7z değil, düz bir .zip) ya da klasörün kendisini bırak.',
    }),
    'too-many-entries': () => ({
      title: 'Bu klasör fazlasıyla büyük',
      hint: 'Bütün bir diski ya da çalışma alanını değil, sadece build’i alınmış siteni (genelde `dist` klasörü) bırak.',
    }),
    'read-failed': () => ({
      title: 'Bazı dosyalar okunamadı',
      hint: 'Tekrar dene ya da build klasörünü zip’leyip .zip’i bırak.',
    }),
  },

  try: {
    title: 'İçe aktarmayı dene',
    intro:
      'Kapışmadan önce pratik yap: yaptığın bir siteyi bırak ve çalıştığını gör. Hiçbir şey yüklenmez; site bu sekmede kalır.',
    home: 'Ana sayfa',
  },

  solo: {
    loadingGame: 'Oyun yükleniyor…',
    stillRunning: 'Bu kapışma hâlâ sürüyor. Sonuçları yakında herkese açık olacak.',
    player: 'Oyuncu',
    title: 'Solo kapışma',
    intro:
      'Rastgele bir PROJE, KURAL ve STİL çevir, sonra zamana karşı yarış. Süre bitmeden teslim et.',
    spinningUp: 'Çark hazırlanıyor…',
    spin: 'Çevir',
    footer: 'Hesap gerekmez. Projen kapışma bitince silinir; sonuçlar kalır.',
    resumeTitle: 'Devam eden bir kapışman var',
    resumeText: 'Aynı anda sadece bir solo kapışma oynanabilir. Süre bitmeden geri dön.',
    resume: 'Kapışmaya dön',
    back: 'Geri',
  },

  spin: {
    heading: (name) => `${name}, görevin…`,
    title: 'ÇARK DÖNÜYOR',
    getReady: 'Yapmaya hazırlan…',
  },

  build: {
    subtitle: 'Solo',
    lowTime: 'Bir dakika kaldı. Teslim etmeyi unutma!',
    criticalTime: 'On saniye! Şimdi teslim et, yoksa son içe aktarman senin yerine teslim edilir.',
    autosave: {
      looking: 'Son içe aktarman aranıyor…',
      nothing: 'Henüz bir şey içe aktarılmadı',
      saving: 'Kaydediliyor…',
      saved: (time) => `Kaydedildi ${time}`.trim(),
      failed: 'Kaydedilemedi, yeniden deneniyor',
      closed: 'Kayıt kapandı',
      notSaved: 'Henüz kaydedilmedi',
    },
    countdownBuild: 'İnşa',
    countdownGrace: 'Ek süre',
    countdownSpin: 'Çark',
    ship: 'Teslim et 🚀',
    importFirst: 'Önce build’i alınmış siteni içe aktar',
    timesUp: 'Süre doldu!',
    shippingForYou: 'Son içe aktarman senin yerine teslim ediliyor…',
    nothingToShip: 'Hiçbir şey içe aktarılmadı, teslim edilecek bir şey yok. Kapışma toparlanıyor…',
    shipped: (name, at) =>
      `🚀 ${name ? `“${name}” ` : ''}teslim edildi${at ? ` (${at})` : ''}. Projen kilitlendi.`,
    wrappingUp: 'Kapışma toparlanıyor…',
  },

  ship: {
    title: 'Teslim edilsin mi?',
    text: 'Sonra bir daha içe aktaramazsın. En son içe aktardığın site dondurulur, ekran görüntüsü alınır ve şu anki hâliyle değerlendirilir.',
    buildName: 'Proje adı',
    thumbnail: 'Anlık görüntü alınıyor…',
    uploading: 'Siten yükleniyor…',
    shipping: 'Teslim ediliyor…',
    done: 'Teslim edildi!',
    keepBuilding: 'Yapmaya devam et',
    tryAgain: 'Tekrar dene',
    ship: 'Teslim et 🚀',
  },

  results: {
    destroying: 'Proje imha ediliyor…',
    destroyed: 'Proje imha edildi',
    lastLookIn: (t) => `Son bakış · bu proje ${t} sonra kendini imha ediyor`,
    lastLookCapture: 'Son bakış · ekran görüntüsü alınır alınmaz imha ediliyor…',
    lastLookDestroying: 'Son bakış · imha ediliyor…',
    eyebrowDestroy: 'Projeyi imha et',
    eyebrowResults: 'Sonuçlar',
    yourBuild: 'Projen',
    byStatus: 'Yapan: {name} · {status}',
    byStatusTime: 'Yapan: {name} · {status} · süre {time}',
    noShot: 'Hiçbir şey teslim edilmedi, bu yüzden ekran görüntüsü yok.',
    sourceDeleted: '✓ İçe aktarılan site sunucudan silindi.',
    sourceDeleting: 'İçe aktarılan site sunucudan siliniyor…',
    permanent: 'Kalıcı sonuçları gör',
    playAgain: 'Tekrar oyna',
  },

  revealPane: {
    frameTitle: 'Teslim ettiğin proje (son bakış)',
    loading: 'Projen yükleniyor…',
    unavailable: 'Gösterilecek bir şey yok: hiç proje teslim edilmedi.',
    noLoad: 'Siten bu tarayıcıda yüklenemedi. Ekran görüntüsü ve sonuçların güvende.',
    noStart: 'Projen burada başlayamadı: önizleme sandbox’ı hiç yanıt vermedi.',
    froze: 'Projen dondu (yanıt vermeyi bıraktı), bu yüzden durduruldu.',
    destroying: 'İMHA EDİLİYOR',
    destroyedStamp: 'PROJE İMHA EDİLDİ',
    destroyedText:
      'İçe aktarılan site artık yok: şimdi bu tarayıcıdan, birazdan da sunucudan siliniyor. Sonuçlar sonsuza kadar kalır.',
  },

  status: {
    draft: 'Yapılıyor',
    shipped: 'Teslim edildi',
    auto_shipped: 'Süre bitince otomatik teslim edildi',
    dnf: 'Bitiremedi',
    disqualified: 'Diskalifiye',
  },

  capture: {
    pending: 'Ekran görüntüsü alınıyor…',
    captured: 'Ekran görüntüsü',
    fallback: 'Ekran görüntüsü (yedek: tarayıcıdaki küçük resim)',
    failed: 'Ekran görüntüsü yok: alınamadı',
  },

  awards: {
    label: 'Ödüller',
    speedrun: { title: 'Speedrun', text: 'Sürenin en fazla yarısını kullanarak teslim etti.' },
    clutch_ship: { title: 'Son saniye teslimi', text: 'Son 10 saniyede teslim etti.' },
    fastest_ship: { title: 'En hızlı teslim', text: 'İlk teslim edilen proje.' },
    mostVotes: (description) => `En çok oy: ${description}`,
    votes: (n) => `${s(n)} oy`,
    perCategory: 'Kategori başına oylar',
  },

  voteCategories: {
    overall: { label: 'En İyi Proje', description: 'Gerçekten kullanacağın proje.' },
    rule: { label: 'Kuralı En İyi Kullanan', description: 'KURAL kartını bir özelliğe çeviren.' },
    style: { label: 'En İyi Stil', description: 'STİL kartını tam on ikiden vuran.' },
    chaos: {
      label: 'En Kaotik',
      description: 'Tatlı bir çılgınlık. Bug’lar özellik olabilir.',
    },
  },

  stats: {
    files: (n) => `${s(n)} dosya`,
    imported: (n) => (n === 1 ? 'bir kez içe aktarıldı' : `${s(n)} kez içe aktarıldı`),
    lines: (n) => `${s(n)} satır`,
    madeWith: (deps) => `kullanılanlar: ${deps}`,
  },

  battlePage: {
    shellTitle: 'Kapışma sonuçları',
    notFoundTitle: 'Kapışma bulunamadı',
    titleBy: (name, builder) => `${name} · Yapan: ${builder}`,
    titleChallenge: (challenge) => `${challenge} · Kapışma sonuçları`,
    loading: 'Sonuçlar yükleniyor…',
    loadError: 'Sonuçlar yüklenemedi. Bağlantını kontrol et, sonra tekrar dene.',
    notFound: 'Bu linke ait bir kapışma yok ya da sonuçları henüz çıkmadı.',
    soloEyebrow: 'Solo kapışma sonuçları',
    roomEyebrow: 'Kapışma sonuçları',
    timeLimit: (t) => `Süre: ${t}`,
    rankedVotes:
      'oyuncuların oylarına göre sıralandı (önce En İyi Proje, sonra tüm oylar, sonra daha erken teslim); her ödül kategorisinin tek kazananı var (eşitlikte toplam oyu fazla olan, sonra daha erken teslim eden kazanır)',
    rankedTime: 'bitirme süresine göre sıralandı',
    builds: 'Projeler',
    nothingShipped: 'Hiçbir şey teslim edilmedi.',
    untitled: 'İsimsiz proje',
    destroyedNote: 'Projeler kapışmadan sonra imha edildi. Projeler geçici. Sonuçlar kalıcı.',
    tagline: 'Projeler geçici. Sonuçlar kalıcı.',
    playSolo: 'Solo oyna',
  },

  history: {
    shellTitle: 'Oyuncu geçmişi',
    notFoundTitle: 'Oyuncu bulunamadı',
    title: (name) => `${name} · Kapışmalar`,
    loading: 'Kapışmalar yükleniyor…',
    loadError: 'Kapışmalar yüklenemedi. Bağlantını kontrol et, sonra tekrar dene.',
    eyebrow: 'Oyuncu geçmişi',
    intro:
      'Biten kapışmalar, en yeniden eskiye. Projeler her kapışmadan sonra imha edilir; sonuçları ve ekran görüntüleri kalır.',
    battles: 'Kapışmalar',
    pages: 'Sayfalar',
    newest: '← En yeni kapışmalar',
    older: 'Daha eski kapışmalar →',
    footer:
      'Bu geçmiş, tek bir tarayıcıdaki anonim bir oyuncuya ait. O tarayıcının verilerini silmek buraya dönüş yolunu kaybettirir (saklamak için bu sayfayı yer imlerine ekle).',
    play: 'Bir kapışma oyna',
    notFoundHeading: 'Gösterilecek kapışma yok',
    notFoundText:
      'Bu oyuncunun henüz biten bir kapışması yok ya da link yanlış. Kapışmalar, sonuçları çıkınca burada görünür.',
    rank: (rank, of) => `#${s(rank)} / ${s(of)}`,
    unranked: 'Sıralama dışı',
    noScreenshot: 'Ekran görüntüsü yok',
    nothingShipped: 'Hiçbir şey teslim edilmedi',
    solo: 'Solo',
    roomBattle: 'Oda kapışması',
    autoShipped: 'otomatik teslim',
  },

  loadStates: {
    title: 'Bu sayfa yüklenemedi',
  },

  notFound: {
    title: 'Bu sayfa bulunamadı.',
  },

  globalError: {
    title: 'Bir şeyler bozuldu',
    text: 'Sayfada bir hata oluştu. Oyunun durumu sunucuda tutulur, bu yüzden sayfayı yenilemek genelde seni kaldığın yere geri götürür.',
  },

  moderation: {
    removed: 'Moderatörler kaldırdı',
    report: 'Bildir',
    reported: 'Bildirildi',
    reportTitle: 'Bu projeyi moderatörlere bildir',
    thanksTitle: 'Bildirdiğin için teşekkürler',
    alreadyTitle: 'Zaten bildirildi',
    thanksText:
      'Bir moderatör inceleyecek. Kurallara aykırıysa sonuçlardan kaldırılır ve ekran görüntüsü silinir. Diğer oyuncular kimin bildirdiğini görmez.',
    alreadyText: 'Bu projeyi zaten bildirdin. Bir moderatör inceleyecek.',
    hideNow: 'Şimdi benden gizle',
    dialogTitle: 'Bu projeyi bildir',
    question: 'Sorun ne?',
    details: 'Ayrıntılar (isteğe bağlı)',
    placeholder: 'Ne gördün? (Linkler, senden ne istediği…)',
    buildGone: 'Bu proje artık yok (zaten kaldırılmış olabilir).',
    justHide: 'Sadece benden gizle',
    sending: 'Gönderiliyor…',
    send: 'Bildirimi gönder',
  },

  reportReasons: {
    offensive: {
      label: 'Saldırgan',
      hint: 'Nefret içeren, cinsel ya da şiddet içeren içerik veya hakaret.',
    },
    phishing: {
      label: 'Oltalama ya da dolandırıcılık',
      hint: 'Şifre, ödeme ya da kişisel bilgi istiyor.',
    },
    malware: {
      label: 'Zararlı yazılım ya da kripto madenciliği',
      hint: 'Tarayıcıyı donduruyor, kripto kazıyor, zararlı kod çalıştırıyor.',
    },
    spam: { label: 'Spam', hint: 'Reklam, link ya da görevle hiç ilgisi yok.' },
    other: { label: 'Başka bir şey', hint: 'Ayrıntılarda anlat.' },
  },

  room: {
    loading: 'Oda yükleniyor…',
    title: 'Oda',
    noCode: 'Bu linkte oda kodu yok.',
    createOrJoin: 'Bir oda kur ya da bir odaya katıl',
    opening: (code) => `${code} odası açılıyor…`,
    joining: (code) => `${code} odasına katılınıyor…`,
    connecting: (code) => `${code} odasına bağlanılıyor…`,
    spinHeading: (code) => `Oda ${code} · herkesin görevi…`,
    waitingOthers: (shipped, total) =>
      `Diğerleri bekleniyor (${s(shipped)}/${s(total)} teslim edildi)…`,
    eyebrow: 'Oda',
    reconnecting: 'Yeniden bağlanılıyor…',
    copyPrompt: 'Davet linkini kopyala:',
    copied: 'Kopyalandı!',
    copyInvite: 'Davet linkini kopyala',
    leave: 'Odadan çık',
    leaveTitle: 'Odadan çıkılsın mı?',
    leaveAfterShipping:
      'Kapışma sensiz devam eder: projen gösterimde ve sonuçlarda kalır. Oylama bitmeden geri dönmezsen oy veremezsin.',
    leaveDuring:
      'Kapışma sensiz devam eder. Geri dönmezsen son otomatik kaydın süre bitince senin yerine teslim edilir.',
    leaveConfirm: 'Çık',
    invited: 'Bu odaya davet edildin',
    joiningButton: 'Katılınıyor…',
    join: 'Odaya katıl',
    nameFooter: 'Hesap gerekmez. Projeler her kapışmadan sonra silinir.',
    joinErrors: {
      room_not_found: {
        title: 'Oda bulunamadı',
        text: (code) => `${code} kodlu bir oda yok. Kodu kontrol et ya da kendi odanı kur.`,
      },
      room_closed: {
        title: 'Bu oda kapandı',
        text: () => 'Odalar herkes ayrılınca ya da iki saat boyunca hiç kapışma olmayınca kapanır.',
      },
      kicked: {
        title: 'Bu odaya katılamazsın',
        text: () => 'Oda sahibi seni bu odadan çıkardı, o yüzden geri dönemezsin.',
      },
      rate_limited: {
        title: 'Çok fazla yanlış oda kodu',
        text: (why) => `${why} Davet linkini oda sahibinden iste.`,
      },
      room_full: {
        title: 'Bu oda dolu',
        text: () =>
          `Bütün oyuncu ve izleyici yerleri dolu (${s(ROOM_LIMITS.max_players)} oyuncu ve ${s(ROOM_LIMITS.max_spectators)} izleyici).`,
      },
    },
    couldNotJoin: 'Odaya katılınamadı',
    another: 'Başka bir oda kur ya da katıl',
    ended: {
      kicked: {
        title: (code) => `${code} odasından çıkarıldın`,
        text: 'Oda sahibi seni attı, bu odaya geri dönemezsin. Ama istediğin zaman kendi odanı kurabilirsin.',
      },
      left: {
        title: (code) => `${code} odasından çıktın`,
        text: 'Fikrini mi değiştirdin? Oda açık olduğu sürece geri dönebilirsin.',
      },
      closed: {
        title: (code) => `${code} odası kapandı`,
        text: 'Herkes ayrıldı ya da iki saat boyunca kimse oynamadı.',
      },
      gone: {
        title: (code) => `${code} odası artık yok`,
        text: 'Bu oda artık mevcut değil.',
      },
    },
    rejoin: 'Odaya geri dön',
  },

  toasts: {
    hostYou: '👑 Artık oda sahibi sensin.',
    hostOther: (name) => `👑 Yeni oda sahibi: ${name ?? 'başka biri'}.`,
    joined: (name, spectator) => `${name} ${spectator ? 'izlemeye geldi' : 'katıldı'}.`,
    left: (name) => `${name} ayrıldı.`,
    kicked: (name) => `${name} oda sahibi tarafından çıkarıldı.`,
    shipped: (who, name, at) =>
      `🚀 ${who ?? 'Sen'} “${name ?? 'İsimsiz'}” projesini teslim ${who === null ? 'ettin' : 'etti'}${
        at ? ` (${at})` : ''
      }`,
  },

  desktop: {
    title: '💻 Proje yapmak için bilgisayar gerekir',
    shipped:
      '**“{name}”** projesini teslim ettin. Kilitlendi: diğerlerinin yapışını burada izle, sonra gösterimi ve oylamayı.',
    yourBuild: 'projen',
    notShipped:
      'Bu kapışmada **oyuncusun**, ama projeni bilgisayarda yaparsın: kendi yapay zekâ aracınla, sonra build’i alınmış siteyi içe aktarırsın. Bu telefon hiçbir şeyi içe aktarmaz ya da otomatik kaydetmez; burada içe aktarıp teslim etmezsen projen süre bitince **Bitiremedi** olarak kapanır.',
    watchVote: 'Herkes gibi bu telefondan da **gösterimi izler ve oy verirsin**.',
    seat: 'Odayı bilgisayarda açmak yerini oraya taşımaz: her tarayıcı ayrı bir anonim oyuncudur ve başlamış bir kapışmaya sadece izleyici katılabilir.',
    buildAnyway: 'Yine de bu cihazda içe aktar',
  },

  progress: {
    shipped: (name, at) => `🚀 “${name}” teslim edildi${at ? ` (${at})` : ''}`,
    left: 'Odadan ayrıldı',
    removed: 'Oda sahibi çıkardı',
    imported: '📦 içe aktardı',
    imports: (n) => `(${s(n)}×)`,
    building: '🛠 yapıyor…',
    onPhone: 'Telefonda',
    offline: 'Çevrimdışı',
    players: 'Oyuncular',
    header: (shipped, total) => `Oyuncular · ${s(shipped)}/${s(total)} teslim etti`,
  },

  spectator: {
    playerWatching: '📱 Oyuncu · izliyor',
    spectating: '👀 İzliyorsun',
    note: 'Bu kapışmayı izliyorsun (sen katılmadan başladı ya da oyuncu yerleri dolu). Bitince boş yer varsa rövanşta oyuncu olursun.',
  },

  lobby: {
    lastSeen: (ago) => `son görülme ${ago}`,
    online: 'çevrimiçi',
    offline: 'çevrimdışı',
    left: 'ayrıldı',
    player: 'Oyuncu',
    spectator: 'İzleyici',
    ready: '✓ Hazır',
    notReady: 'Hazır değil',
    remove: (name) => `${name} adlı oyuncuyu çıkar`,
    kick: 'At',
    players: 'Oyuncular',
    playerCount: (n, max) => `${s(n)}/${s(max)} oyuncu`,
    spectators: (n, max) => `İzleyiciler (${s(n)}/${s(max)})`,
    spectatorsLabel: 'İzleyiciler',
    leftRoom: 'Odadan ayrılanlar',
    readyDone: '✓ Hazırsın!',
    readyUp: 'Hazırım',
    spectatingNote: '**İzliyorsun**. Bir oyuncu yeri boşalınca sana geçer.',
    maxPlayers: 'En fazla oyuncu',
    spinningUp: 'Çark hazırlanıyor…',
    startRematch: 'Rövanşı başlat',
    startBattle: 'Kapışmayı başlat',
    readySummary: (ready, enough, min) =>
      `${s(ready)} hazır · ${
        enough ? 'hazır ve çevrimiçi olan herkes oynar' : `en az ${s(min)} hazır oyuncu gerekiyor`
      }`,
    waitingBattle: '{host} kapışmayı başlatacak, bekleniyor… ({ready} hazır)',
    waitingRematch: '{host} rövanşı başlatacak, bekleniyor… ({ready} hazır)',
    theHost: 'Oda sahibi',
    phoneNote:
      '📱 Telefonda kapışmayı izlersin, sonra gösterime ve oylamaya katılırsın. Proje yapmak için bilgisayar gerekir (kendi yapay zekâ araçlarınla yapıp sonucu içe aktarırsın): buradan oynarsan projen Bitiremedi olarak kapanır.',
    historyLink: 'Kapışma geçmişin ↗',
    howTitle: 'Bir kapışma nasıl geçer',
    how: (limits) => [
      `Çarklar bir PROJE, bir KURAL, bir STİL ve bir süre seçer (${limits} dk).`,
      'Herkes aynı görevi kendi bilgisayarında, kendi yapay zekâ araçlarıyla yapar ve build’i alınmış siteyi içe aktarır.',
      'Süre bitmeden teslim et. Hızlı teslim ödül kazandırır.',
      'Gösterim: herkes her projeyi tek tek izler.',
      'Herkes dört kategoride oy verir (kendi projesine asla).',
      'Oylara göre sonuçlar, bir son bakış ve ardından bütün projeler imha edilir.',
    ],
    kickTitle: (name) => `${name} atılsın mı?`,
    kickBody: 'Odadan hemen çıkar ve bu kodla geri dönemez.',
    lastBattle: 'Son kapışma',
    nobodyShipped: 'Kimse teslim etmedi.',
    abandoned: 'Terk edildi (kimse kalmadı), bu yüzden sonuç sayfası yok.',
    settingsOff: 'Gösterim ve oylama kapalı: sonuçlar bitirme süresine göre.',
    slotFixed: (seconds) => `proje başına ${s(seconds)} sn`,
    slotAuto: (range) => `proje başına ${range} (proje sayısına göre)`,
    settingsOn: (slot, voting) => `Gösterim ve oylama açık · ${slot} · oylama ${s(voting)} sn.`,
    afterBuild: 'İnşadan sonra',
    revealVote: 'Gösterim ve oylama',
    revealVoteOn: 'Herkes her projeyi izler, sonra oy verir.',
    revealVoteOff: 'Sonuçlar bitirme süresine göre.',
    timePerBuild: 'Gösterim süresi',
    auto: (range) => `Otomatik (${range})`,
    votingTime: 'Oylama süresi',
  },

  reveal: {
    badge: '🎬 Gösterim',
    spectating: '👀 İzliyorsun',
    thisBuild: 'Bu proje',
    spotlight: 'Sahnedeki proje',
    position: (n, total) => `Proje ${s(n)} / ${s(total)}`,
    byName: 'Yapan: {name}',
    thatsYou: '(bu sensin!)',
    autoShipped: 'Otomatik teslim',
    autoShippedTitle: 'Elle teslim edilmedi: son otomatik kayıt süre bitince teslim edildi',
    userMade: '⚠ Oyuncu yapımı proje',
    sandboxNote: (name) =>
      `Yapan: ${name} · sandbox içinde çalışır, hesabını göremez. İçindeki hiçbir şey Build Roulette adına iş yapamaz.`,
    runAgain: '▶ Yeniden çalıştır',
    still: 'Ekran görüntüsü · çalışmıyor',
    skipTitle: 'Bu projeyi kendi ekranında durdur (oda devam eder)',
    skip: '⏭ Bu projeyi atla',
    tapToRun: '▶ Canlı çalıştırmak için dokun',
    frameTitle: (name, builder) => `${name} · Yapan: ${builder} (oyuncu yapımı proje)`,
    couldNotLoad: (why) => `Bu proje yüklenemedi. ${why}`,
    nothingToRun: 'Bu projede çalıştırılacak bir şey yok.',
    loadingBuilds: (why) => `Projeler yükleniyor… (${why})`,
    loadingBuild: 'Proje yükleniyor…',
    theHost: 'Oda sahibi',
    challenge: 'Görev',
    watchNote:
      'Dikkatle izle: gösterim bitince her oyuncu dört kategoride en iyi projeye oy verir (kendi projesine asla).',
    stopped: {
      skipped: 'Bu projeyi atladın. Diğer herkes için devam ediyor.',
      frozen:
        'Bu proje dondu, bu yüzden senin ekranında durduruldu. Diğer herkes izlemeye devam ediyor.',
      no_start:
        'Bu proje senin ekranında başlayamadı (sandbox’ı hiç yanıt vermedi). Diğer herkes izlemeye devam ediyor.',
      no_load:
        'Bu proje senin ekranında yüklenemedi, onun yerine ekran görüntüsü burada. Diğer herkes izlemeye devam ediyor.',
    },
    hostNote:
      '👑 {host} sonraki projeye geçebilir ya da oylamaya atlayabilir. Yoksa her proje süresinin tamamını alır.',
    hostTitle: '👑 Gösterimi sen yönetiyorsun',
    movingOn: 'Geçiliyor…',
    nextVote: 'Sıradaki: oylamayı başlat ▶',
    next: 'Sonraki proje ▶',
    skipping: 'Atlanıyor…',
    skipToVote: '⏭ Oylamaya geç',
    strip: 'Gösterimdeki bütün projeler',
    thumbnailOf: (name) => `Küçük resim: ${name}`,
    comingUp: 'Sırada',
  },

  vote: {
    watching: 'İzliyorsun: sadece bu kapışmanın oyuncuları oy verir. Sırada sonuçlar var.',
    cannotVote: 'Bu kapışmada oy veremezsin.',
    left: 'Odadan ayrıldığın için oy veremezsin. Oy vermek için odaya yeniden katıl.',
    closed: 'Oylama kapandı.',
    badge: '🗳️ Oylama',
    countdown: 'Oylama',
    heading: 'En iyi projelere oy ver',
    intro: (picked, total) =>
      `Her kategoride bir seçim, kendi projen asla. Süre bitene kadar seçimlerini değiştirebilirsin (${s(picked)}/${s(total)} seçildi).`,
    unsent: (n) =>
      `⚠ Henüz kaydedilmedi: sunucuya ulaşılamıyor. ${
        n === 1 ? 'Seçimin' : `${s(n)} seçimin`
      } bağlantı gelir gelmez yeniden gönderilecek. Bu sayfayı açık tut.`,
    complete: (voted, eligible) =>
      `✓ Oy pusulan tamam. Diğerleri bekleniyor${
        voted !== null && eligible !== null ? ` (${s(voted)}/${s(eligible)} oy verdi)` : ''
      }. Süre bitene kadar seçimini yine de değiştirebilirsin.`,
    progressLabel: (voted, eligible) => `${s(eligible)} oyuncudan ${s(voted)} tanesi oy verdi`,
    progress: (voted, eligible) => `${s(voted)}/${s(eligible)} oy verdi`,
    saving: 'Kaydediliyor…',
    unsentStatus: '⚠ Henüz kaydedilmedi · yeniden deneniyor',
    picked: '✓ Seçildi',
    pickOne: 'Birini seç',
    yourPick: '✓ Senin seçimin',
    notSaved: 'Henüz kaydedilmedi',
    yourBuild: 'Senin projen',
    imageAlt: (name, builder) => `${name} · Yapan: ${builder}`,
    ownTitle: 'Kendi projene oy veremezsin',
    optionLabel: (category, name, builder) => `${category}: ${name} · Yapan: ${builder}`,
  },

  roomResults: {
    destroying: 'Bütün projeler imha ediliyor…',
    destroyed: 'Projeler imha edildi',
    lastLookIn: (player, t) =>
      `Son bakış · ${player ? 'projen' : 'projeler'} ${t} sonra kendini imha ediyor`,
    lastLookCaptures: 'Son bakış · ekran görüntüleri alınır alınmaz imha ediliyor…',
    lastLookDestroying: 'Son bakış · imha ediliyor…',
    rankedVotes:
      'Oylara göre sıralandı: önce En İyi Proje, sonra tüm oylar, sonra daha erken teslim. Her kategori ödülünün tek kazananı var: eşitlikte toplam oyu fazla olan, sonra daha erken teslim eden kazanır.',
    rankedTime: 'Bitirme süresine göre sıralandı.',
    ranking: 'Sıralama',
    removedMine: 'Projen moderatörler tarafından kaldırıldı.',
    disqualifiedMine: 'Projen diskalifiye edildi.',
    didNotShip: 'Bu sefer teslim etmedin. Rövanş her zaman var.',
    lostPick: (category, name) => (name ? `${category} (“${name}”)` : category),
    lost: (count, list) =>
      `Sayılmadı: ${list} için ${count === 1 ? 'seçimin' : 'seçimlerin'} oylama kapanmadan sunucuya ulaşmadı (bağlantı kopuktu).`,
    autoShipped: 'Otomatik teslim',
    dnf: 'Bitiremedi',
    disqualified: 'Diskalifiye',
    nothingShipped: 'Teslim edilmedi',
    historyTitle: (name) => `${name} · Kapışmalar (yeni sekmede açılır)`,
  },

  errors: {
    not_authenticated: 'Oturumunun süresi doldu. Yeniden giriş için sayfayı yenile.',
    not_on_roster: 'Bu kapışmada oyuncu değilsin.',
    not_a_member: 'Artık bu odada değilsin. Önce odaya yeniden katıl.',
    not_a_player: 'İzleyiciler bunu yapamaz. Boş bir oyuncu yeri bekle.',
    not_host: 'Bunu sadece oda sahibi yapabilir.',
    kicked: 'Oda sahibi seni bu odadan çıkardı. Geri katılamazsın.',
    battle_not_found: 'Bu kapışma yok ya da senin değil.',
    room_not_found: 'Bu kodlu bir oda yok. Kodu kontrol et ya da yeni bir oda kur.',
    member_not_found: 'Bu oyuncu artık odada değil.',
    invalid_time_limit: 'Bu süreye izin verilmiyor.',
    invalid_display_name: 'Adın 1 ile 24 karakter arasında olmalı.',
    invalid_name: 'Proje adı 1 ile 48 karakter arasında olmalı.',
    invalid_stats:
      'Sunucu proje istatistiklerini reddetti. Bu bir hata; istatistikler olmadan teslim ediliyor.',
    stats_too_large:
      'Sunucu proje istatistiklerini reddetti. Bu bir hata; istatistikler olmadan teslim ediliyor.',
    invalid_version: 'Oyun senkronunu kaybetti. Sayfayı yenile.',
    invalid_ready: 'Hazır durumu açık ya da kapalı olmalı.',
    invalid_settings: 'Bu oda ayarlarına izin verilmiyor.',
    wrong_phase: 'Çok geç: kapışma çoktan bir sonraki aşamaya geçti.',
    wrong_room_state: 'Şimdi olmaz: bu odada bir kapışma sürüyor.',
    deadline_passed: 'Süre doldu: son teslim zamanı ve ek süre bitti.',
    already_shipped: 'Zaten teslim edildi. Teslim kesindir.',
    disqualified: 'Projen diskalifiye edildi.',
    files_missing: 'Yükleme tamamlanmadı. Yeniden teslim etmeyi dene.',
    battle_in_progress: 'Zaten devam eden bir kapışman var.',
    deck_empty: 'Şu anda hiç görev kartı yok. Birazdan tekrar dene.',
    room_closed: 'Bu oda kapandı. Yeniden oynamak için yeni bir oda kur.',
    room_full: 'Bu oda dolu: bütün oyuncu ve izleyici yerleri alınmış.',
    room_busy: 'Oda şu anda meşgul. Birazdan tekrar dene.',
    too_many_rooms: 'Zaten açık 3 odanın sahibisin. Önce birinden çık.',
    not_enough_players: 'Başlamak için en az 2 oyuncunun hazır (ve çevrimiçi) olması gerekir.',
    cannot_kick_self: 'Kendini atamazsın. Bunun yerine odadan çık.',
    not_implemented: 'Bu henüz yok.',
    not_a_voter: 'Bu kapışmada oy veremezsin.',
    build_not_found: 'Bu proje bu kapışmanın parçası değil.',
    invalid_category: 'Böyle bir oy kategorisi yok.',
    self_vote: 'Kendi projene oy veremezsin.',
    not_votable: 'Bu proje oy alamaz: teslim edilmedi.',
    name_not_allowed: 'Bu ada burada izin verilmiyor. Başka bir ad seç.',
    invalid_reason: 'Bildirim için bir sebep seç.',
    invalid_details: 'Ayrıntılar çok uzun (en fazla 500 karakter).',
    own_build: 'Kendi projeni bildiremezsin.',
    already_reported: 'Bu projeyi zaten bildirdin. Teşekkürler, bir moderatör inceleyecek.',
    upload_refused: 'Sunucu yüklemeyi reddetti: süre dolmuş olabilir.',
    file_too_large:
      'Siten 5 MB sınırını aşıyor. Büyük görselleri, videoları ya da fontları küçült.',
    nothing_built: 'Önce build’i alınmış siteni içe aktar, sonra teslim et.',
    network: 'Sunucuya ulaşılamıyor. Bağlantını kontrol et ve tekrar dene.',
    rate_limited: 'Şu anda çok fazla istek var. Birkaç dakika bekleyip tekrar dene.',
    unknown: 'Bir şeyler ters gitti. Tekrar dene.',
  },

  rateLimitedDetails: (details) => {
    const m = /try again in (\d+) (second|minute|hour)s?/i.exec(details);
    const unit = m ? UNITS[(m[2] ?? '').toLowerCase()] : undefined;
    return m && unit
      ? `Kısa sürede çok fazla istek gönderdin. ${m[1] ?? ''} ${unit} sonra tekrar dene.`
      : 'Şu anda çok fazla istek var. Birkaç dakika bekleyip tekrar dene.';
  },

  voteErrors: {
    battle_not_found: 'Bu kapışma artık yok. Sayfayı yenile.',
    not_on_roster: 'Sadece bu kapışmanın oyuncuları oy verir. İzleyiciler sonuçları izler.',
    kicked: 'Oda sahibi seni bu odadan çıkardı, bu yüzden oy veremezsin.',
    not_a_member: 'Odadan ayrıldın. Süre bitmeden oy vermek için yeniden katıl.',
    not_a_voter: 'Bu kapışmada oy veremezsin.',
    wrong_phase: 'Oylama bitti: sonuçlar açıklandı.',
    deadline_passed: 'Çok geç: oylama az önce kapandı.',
    invalid_category: 'Bu oy kategorisi artık yok. Sayfayı yenile.',
    build_not_found: 'Bu proje bu kapışmanın parçası değil.',
    self_vote: 'İyi denemeydi: kendi projene oy veremezsin.',
    not_votable: 'Bu proje oy alamaz: teslim edilmedi.',
  },
};
