import OpenAI from "openai";

const directKey = process.env.OPENAI_API_KEY?.trim();
const proxyKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim();
const proxyBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim();

if (!directKey && (!proxyKey || !proxyBaseURL)) {
  throw new Error(
    "OpenAI is not configured: set OPENAI_API_KEY, or provision the Replit OpenAI integration",
  );
}

export const openai = new OpenAI({
  apiKey: directKey || proxyKey,
  ...(directKey ? {} : { baseURL: proxyBaseURL }),
});