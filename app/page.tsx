"use client";

import { FormEvent, useState } from "react";

type Mode = "全部" | "经典美食" | "AI创意菜" | "全球经典" | "融合创意";
type Recipe = {
  recipe_id: number;
  recipe_name: string;
  recipe_mode: string;
  cuisine: string;
  dish_type: string;
  difficulty: string;
  total_minutes: number;
  taste: string;
  summary: string;
  source: string;
  ingredients: Array<{ ingredient_name: string; amount: string }>;
  steps: string[];
};

const modes: Mode[] = ["全部", "经典美食", "AI创意菜", "全球经典", "融合创意"];
const examples = [
  "家里有土豆、胡萝卜、一节西葫芦，一小块茄子，我想做一个西餐",
  "草莓、香蕉、土豆、蘑菇",
  "土豆、鸡蛋",
  "意大利面、西红柿、生抽",
];

export default function Home() {
  const [input, setInput] = useState(examples[0]);
  const [mode, setMode] = useState<Mode>("全部");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recognized, setRecognized] = useState<string[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients: input, mode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "查询失败");
      setRecipes(data.recipes);
      setRecognized(data.recognizedIngredients);
      setUnknown(data.unrecognizedIngredients);
      setNote(data.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AI环球厨房首页">
          <span className="brandMark">AI</span>
          <span>AI环球厨房</span>
        </a>
        <span className="dbStatus">45 道菜 · 75 种食材 · 严格匹配</span>
      </header>

      <section className="workspace" id="top">
        <div className="queryPanel">
          <div className="titleBlock">
            <p className="eyebrow">GLOBAL PANTRY</p>
            <h1>今天，用冰箱里的食材环游世界</h1>
            <p>经典地域风味与融合创意同桌出现，只推荐你现在真正做得出的菜。</p>
          </div>

          <form onSubmit={submit}>
            <label htmlFor="ingredients">告诉 Agent 现有食材与想吃的风格</label>
            <div className="inputRow">
              <input
                id="ingredients"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="例如：家里有土豆和鸡蛋，我想做西餐"
                autoComplete="off"
              />
              <button type="submit" disabled={loading || !input.trim()}>
                {loading ? "正在搭配" : "生成菜单"}
              </button>
            </div>

            <div className="modeGroup" aria-label="菜谱模式">
              {modes.map((item) => (
                <button
                  type="button"
                  className={mode === item ? "mode active" : "mode"}
                  aria-pressed={mode === item}
                  onClick={() => setMode(item)}
                  key={item}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="examples">
              {examples.map((example) => (
                <button type="button" onClick={() => setInput(example)} key={example}>
                  {example}
                </button>
              ))}
            </div>
          </form>
        </div>

        <aside className="rulePanel">
          <span className="ruleNumber">01</span>
          <h2>食材边界，由 SQL 决定</h2>
          <p>每道菜的必需用料必须全部出现在你的清单中。油、盐、水是仅有的默认常备品。</p>
          <div className="ruleLine" />
          <span className="ruleNumber">02</span>
          <h2>AI 理解，程序复核</h2>
          <p>Agent 识别数量、菜系和口味，调用 SQL；需要创作时，生成结果还要通过食材白名单校验。</p>
        </aside>
      </section>

      <section className="results" aria-live="polite">
        {error && <div className="message error">{error}</div>}
        {!error && note && (
          <div className="resultHeader">
            <div>
              <p className="eyebrow">YOUR MENU</p>
              <h2>{recipes.length ? `${recipes.length} 道可完成菜谱` : "暂无严格匹配"}</h2>
            </div>
            <p>{note}</p>
          </div>
        )}

        {(recognized.length > 0 || unknown.length > 0) && (
          <div className="ingredientSummary">
            <span>已识别：{recognized.join("、") || "无"}</span>
            {unknown.length > 0 && <span className="unknown">未收录：{unknown.join("、")}</span>}
          </div>
        )}

        <div className="recipeGrid">
          {recipes.map((recipe, index) => (
            <article className="recipeCard" key={recipe.recipe_id}>
              <div className="cardTop">
                <span className="index">{String(index + 1).padStart(2, "0")}</span>
                <div className="sourceTags">
                  <span className="source">{recipe.source}</span>
                  <span className={`tag tag-${recipe.recipe_mode}`}>{recipe.recipe_mode}</span>
                </div>
              </div>
              <p className="cuisine">{recipe.cuisine} · {recipe.dish_type}</p>
              <h3>{recipe.recipe_name}</h3>
              <p className="summary">{recipe.summary}</p>
              <div className="meta">
                <span>{recipe.total_minutes} 分钟</span>
                <span>{recipe.difficulty}</span>
                <span>{recipe.taste}</span>
              </div>
              <div className="ingredients">
                <h4>用料</h4>
                <p>{recipe.ingredients.map((item) => `${item.ingredient_name} ${item.amount}`).join(" · ")}</p>
              </div>
              <ol>
                {recipe.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
