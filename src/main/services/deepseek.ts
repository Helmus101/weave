interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class DeepSeekService {
  constructor(private apiKeyProvider: () => string | undefined) {}

  async reason(prompt: string): Promise<string> {
    return this.complete([
      {
        role: "system",
        content: "You are Weave's Intelligence Engine. You synthesize insights from a 6-layer memory graph."
      },
      { role: "user", content: prompt }
    ], "I'm sorry, I couldn't process that memory right now.");
  }

  hasApiKey(): boolean {
    return !!this.apiKeyProvider();
  }

  private async complete(messages: DeepSeekMessage[], fallback: string): Promise<string> {
    const apiKey = this.apiKeyProvider();
    if (!apiKey) return fallback;

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.3,
          messages
        })
      });

      if (!response.ok) return fallback;
      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content?.trim() || fallback;
    } catch {
      return fallback;
    }
  }
}
