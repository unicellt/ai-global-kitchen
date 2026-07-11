import { env } from "cloudflare:workers";

type RuntimeEnv = { DB: D1Database; DASHSCOPE_API_KEY?: string };
type Mode = "全部" | "经典美食" | "AI创意菜" | "全球经典" | "融合创意";
type ParsedIngredient = { name: string; quantity: string };
type Intent = {
  ingredients: ParsedIngredient[];
  requestedMode: Mode;
  cuisinePreference: string;
  tastePreference: string;
  cookingPreference: string;
};
type RecipeRow = Record<string, unknown> & {
  recipe_id: number;
  recipe_name: string;
  recipe_mode: string;
  cuisine: string;
};

const allowedModes = new Set<Mode>(["全部", "经典美食", "AI创意菜", "全球经典", "融合创意"]);
const pantryBasics = new Set(["油", "盐", "水"]);
const aliases: Record<string, string> = {
  番茄: "西红柿", 马铃薯: "土豆", 洋芋: "土豆", 角瓜: "西葫芦",
  菌菇: "蘑菇", 白蘑菇: "蘑菇", 鲜蘑: "蘑菇", 青菜: "菠菜",
};

function parseJson<T>(content: string): T | null {
  try {
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

async function callQwen(messages: Array<{ role: string; content: string }>, temperature = 0.2) {
  const apiKey = (env as unknown as RuntimeEnv).DASHSCOPE_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen-flash", messages, temperature, response_format: { type: "json_object" } }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function fallbackIntent(raw: string, knownIngredients: string[], selectedMode: Mode): Intent {
  const normalized = Object.entries(aliases).reduce(
    (text, [alias, canonical]) => text.replaceAll(alias, canonical), raw,
  );
  const ingredients = knownIngredients
    .filter((name) => normalized.includes(name))
    .map((name) => ({ name, quantity: "适量" }));
  return {
    ingredients,
    requestedMode: selectedMode,
    cuisinePreference: /西餐|西式|欧洲|欧美/.test(raw) ? "西餐" : "不限",
    tastePreference: "不限",
    cookingPreference: "不限",
  };
}

async function understandRequest(raw: string, selectedMode: Mode, knownIngredients: string[]): Promise<Intent> {
  const prompt = `你是厨房 Agent 的意图解析器。把用户自然语言转换成 JSON，不要回答菜谱。
已知标准食材名：${knownIngredients.join("、")}。
要求：
1. 去掉“家里有、一些、一节、一小块”等修饰，但保留 quantity。
2. 使用标准名；番茄=西红柿，马铃薯/洋芋=土豆，角瓜=西葫芦。
3. “西餐/西式”写入 cuisinePreference，不要把它当食材。
4. requestedMode 只能是 全部、经典美食、AI创意菜、全球经典、融合创意；用户没明确说这些分类就用“全部”。
字段取值必须具体，不要输出“或”。例如：{"ingredients":[{"name":"土豆","quantity":"1个"}],"requestedMode":"全部","cuisinePreference":"西餐","tastePreference":"不限","cookingPreference":"不限"}`;
  const content = await callQwen([
    { role: "system", content: prompt },
    { role: "user", content: raw },
  ]);
  const parsed = content ? parseJson<Intent>(content) : null;
  if (!parsed?.ingredients?.length) return fallbackIntent(raw, knownIngredients, selectedMode);

  const seen = new Set<string>();
  const ingredients = parsed.ingredients
    .map((item) => ({ name: aliases[item.name] || item.name.trim(), quantity: item.quantity?.trim() || "适量" }))
    .filter((item) => item.name && !seen.has(item.name) && seen.add(item.name));
  return {
    ingredients,
    requestedMode: selectedMode !== "全部"
      ? selectedMode
      : allowedModes.has(parsed.requestedMode) ? parsed.requestedMode : "全部",
    cuisinePreference: String(parsed.cuisinePreference).includes("西餐") ? "西餐" : (parsed.cuisinePreference || "不限"),
    tastePreference: String(parsed.tastePreference).includes("不限") ? "不限" : (parsed.tastePreference || "不限"),
    cookingPreference: String(parsed.cookingPreference).includes("不限") ? "不限" : (parsed.cookingPreference || "不限"),
  };
}

async function queryRecipes(db: D1Database, ingredients: string[], mode: Mode, cuisinePreference: string) {
  const placeholders = ingredients.map(() => "?").join(", ");
  const modeClause = mode === "全部" ? "" : "AND r.recipe_mode = ?";
  const modeParams = mode === "全部" ? [] : [mode];
  const wantsWestern = cuisinePreference.includes("西餐");
  const cuisineClause = wantsWestern
    ? `AND r.recipe_mode IN ('全球经典', '融合创意')
       AND r.cuisine NOT IN ('韩国', '日本', '泰国', '越南', '印度', '中东', '中韩融合', '中印融合', '亚洲甜品融合')`
    : "";
  const globalFirst = wantsWestern
    ? "CASE WHEN r.recipe_mode IN ('全球经典', '融合创意') THEN 0 ELSE 1 END,"
    : "";
  const sql = `
    SELECT r.recipe_id, r.recipe_name, r.recipe_mode, r.cuisine, r.dish_type,
           r.difficulty, r.prep_minutes + r.cook_minutes AS total_minutes,
           r.taste, r.summary
    FROM recipes r
    WHERE 1 = 1 ${modeClause} ${cuisineClause}
      AND NOT EXISTS (
        SELECT 1 FROM recipe_ingredients ri
        JOIN ingredients i ON i.ingredient_id = ri.ingredient_id
        WHERE ri.recipe_id = r.recipe_id AND ri.is_required = 1
          AND i.ingredient_name NOT IN (${placeholders})
      )
      AND EXISTS (
        SELECT 1 FROM recipe_ingredients ri
        JOIN ingredients i ON i.ingredient_id = ri.ingredient_id
        WHERE ri.recipe_id = r.recipe_id AND i.ingredient_name IN (${placeholders})
      )
    ORDER BY ${globalFirst} r.recipe_mode, total_minutes, r.recipe_id
    LIMIT 8`;
  const { results } = await db.prepare(sql).bind(...modeParams, ...ingredients, ...ingredients).all<RecipeRow>();
  return results;
}

async function hydrateRecipes(db: D1Database, rows: RecipeRow[]) {
  return Promise.all(rows.map(async (recipe) => {
    const recipeId = Number(recipe.recipe_id);
    const ingredientRows = await db.prepare(`
      SELECT i.ingredient_name, ri.amount FROM recipe_ingredients ri
      JOIN ingredients i ON i.ingredient_id = ri.ingredient_id
      WHERE ri.recipe_id = ? AND (ri.is_required = 1 OR i.ingredient_name = '盐')
      ORDER BY ri.is_required DESC, i.ingredient_id`).bind(recipeId).all();
    const stepRows = await db.prepare(
      "SELECT instruction FROM recipe_steps WHERE recipe_id = ? ORDER BY step_no"
    ).bind(recipeId).all<{ instruction: string }>();
    return {
      ...recipe,
      source: "SQL菜谱库",
      ingredients: ingredientRows.results,
      steps: stepRows.results.map((row) => row.instruction),
    };
  }));
}

async function generateCreativeRecipes(intent: Intent, knownIngredientNames: string[]) {
  const allowed = new Set([...intent.ingredients.map((item) => item.name), ...pantryBasics]);
  const prompt = `你是 AI环球厨房的创意主厨。基于用户真实拥有的食材生成 1-2 道可执行菜谱。
允许食材（不可超出）：${[...allowed].join("、")}。
数量：${intent.ingredients.map((item) => `${item.name}${item.quantity}`).join("、")}。
菜系偏好：${intent.cuisinePreference}；口味：${intent.tastePreference}；做法：${intent.cookingPreference}。
绝对禁止添加允许列表之外的主料、配菜、香料、酱料或替代品。不能建议购买。油、盐、水可以使用。
每一步也只能出现允许食材。若数量很少，缩小份量。
只返回 JSON：{"recipes":[{"recipe_name":"名称","recipe_mode":"融合创意","cuisine":"地域/融合风格","dish_type":"热菜","difficulty":"简单","total_minutes":20,"taste":"风味","summary":"特色","ingredients":[{"ingredient_name":"土豆","amount":"1个"}],"steps":["步骤1","步骤2"]}]}`;
  const content = await callQwen([
    { role: "system", content: prompt },
    { role: "user", content: "生成严格不越界的菜谱。" },
  ], 0.55);
  const parsed = content ? parseJson<{ recipes?: Array<Record<string, unknown>> }>(content) : null;
  const candidates = parsed?.recipes || [];
  const forbiddenNames = knownIngredientNames.filter((name) => !allowed.has(name));

  return candidates.filter((recipe) => {
    const used = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.map((item) => aliases[String((item as Record<string, unknown>).ingredient_name)] || String((item as Record<string, unknown>).ingredient_name))
      : [];
    const steps = Array.isArray(recipe.steps) ? recipe.steps.map(String) : [];
    if (!used.length || !steps.length || used.some((name) => !allowed.has(name))) return false;
    return !forbiddenNames.some((name) => steps.some((step) => step.includes(name)));
  }).map((recipe, index) => ({
    ...recipe,
    recipe_id: -(index + 1),
    source: "AI受约束创作",
    recipe_mode: recipe.recipe_mode || "融合创意",
  }));
}

export async function POST(request: Request) {
  const body = await request.json() as { ingredients?: unknown; mode?: Mode };
  const raw = Array.isArray(body.ingredients) ? body.ingredients.join("、") : String(body.ingredients ?? "").trim();
  const selectedMode = allowedModes.has(body.mode || "全部") ? (body.mode || "全部") : "全部";
  if (!raw) return Response.json({ error: "请至少输入一种食材" }, { status: 400 });

  const db = (env as unknown as RuntimeEnv).DB;
  const ingredientRows = await db.prepare("SELECT ingredient_name FROM ingredients ORDER BY ingredient_id")
    .all<{ ingredient_name: string }>();
  const knownIngredientNames = ingredientRows.results.map((row) => row.ingredient_name);
  const intent = await understandRequest(raw, selectedMode, knownIngredientNames);
  const requestedNames = intent.ingredients.map((item) => item.name);
  const recognizedIngredients = requestedNames.filter((name) => knownIngredientNames.includes(name));
  const unrecognizedIngredients = requestedNames.filter((name) => !knownIngredientNames.includes(name));

  let sqlRecipes: Array<Record<string, unknown>> = [];
  if (recognizedIngredients.length) {
    const rows = await queryRecipes(db, recognizedIngredients, intent.requestedMode, intent.cuisinePreference);
    sqlRecipes = await hydrateRecipes(db, rows);
  }

  const wantsCreative = intent.requestedMode === "AI创意菜" || intent.requestedMode === "融合创意";
  const needsCreative = sqlRecipes.length === 0 || (wantsCreative && sqlRecipes.length < 2);
  const creativeRecipes = needsCreative
    ? await generateCreativeRecipes(intent, knownIngredientNames)
    : [];
  const recipes = [...sqlRecipes, ...creativeRecipes].slice(0, 8);
  const note = recipes.length
    ? `Agent 已识别 ${intent.ingredients.map((item) => `${item.name}${item.quantity === "适量" ? "" : `（${item.quantity}）`}`).join("、")}，并按${intent.cuisinePreference === "不限" ? "所选模式" : intent.cuisinePreference}完成 SQL 查询${creativeRecipes.length ? "与受约束创作" : ""}。`
    : "Agent 已理解你的食材和偏好，但 SQL 与受约束创作都没有产生通过食材校验的菜谱。";

  return Response.json({
    recipes,
    recognizedIngredients,
    unrecognizedIngredients,
    note,
    intent,
    agentUsed: true,
    aiUsed: true,
  });
}
