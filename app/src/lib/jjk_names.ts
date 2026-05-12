const FIRST_NAMES = [
  "Yuji", "Megumi", "Nobara", "Satoru", "Maki", "Toge", "Panda", "Kento",
  "Suguru", "Yuta", "Kinji", "Hakari", "Kirara", "Ryu", "Takako", "Aoi",
  "Mai", "Momo", "Kasumi", "Noritoshi", "Kokichi", "Masamichi", "Shoko", "Utahime",
  "Mei", "Choso", "Naoya", "Jogo", "Hanami", "Dagon", "Mahito", "Kenjaku",
  "Geto", "Sukuna", "Hana", "Angel", "Rika", "Tsumiki", "Toji", "Junpei",
  "Kamo", "Reggie", "Charles", "Higuruma", "Uraume", "Miguel", "Larue", "Atsuya",
  "Yuki", "Todo", "Ino", "Nitta", "Akari", "Iori",
];

const LAST_NAMES = [
  "Itadori", "Fushiguro", "Kugisaki", "Gojo", "Zenin", "Inumaki", "Panda", "Nanami",
  "Geto", "Okkotsu", "Hakari", "Hoshi", "Ishigori", "Uro", "Todo", "Nishimiya",
  "Miwa", "Kamo", "Muta", "Yaga", "Ieiri", "Utahime", "Mei", "Choso",
  "Jogo", "Hanami", "Dagon", "Mahito", "Kenjaku", "Sukuna", "Kurusu", "Angel",
  "Orimoto", "Takaba", "Higuruma", "Awasaka", "Ogami", "Shigemo", "Ino", "Nitta",
  "Kusakabe", "Haibara", "Amanai", "Fushiguro", "Zenin", "Kamo", "Tsukumo", "Todo",
  "Miguel", "Larue", "Charles", "Reggie", "Uraume", "Aida",
];

function hash_string(value: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

export function get_jjk_name(user_id: string): string {
  const first = FIRST_NAMES[hash_string(user_id, 2166136261) % FIRST_NAMES.length];
  const last = LAST_NAMES[hash_string(user_id, 2654435761) % LAST_NAMES.length];
  return `${first} ${last}`;
}
