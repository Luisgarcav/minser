import type { Answer, LookupService } from "./parallel";

const example: Answer = {
  text: "Measure of the average uncertainty of a random variable.¹ In information theory, the number of bits needed on average to describe an outcome.² Not a measure of disorder, but of missing information.³",
  sources: [
    {
      title: "Entropy (information theory)",
      url: "https://en.wikipedia.org/wiki/Entropy_(information_theory)",
      excerpts: [],
    },
    {
      title: "Information",
      url: "https://plato.stanford.edu/entries/information/",
      excerpts: [],
    },
    {
      title: "entropy",
      url: "https://ncatlab.org/nlab/show/entropy",
      excerpts: [],
    },
  ],
};

/** Local illustrative text, never presented as downloaded source quotations. */
export function createDemoService(): LookupService {
  let nextId = 0;
  return {
    async search(_term, _context, _signal, _effort, previousResponseId) {
      return {
        ...structuredClone(example),
        responseId: `demo-response-${++nextId}`,
        ...(previousResponseId
          ? {
              text: "For a fair coin, either outcome has probability one half, so its entropy is one bit.¹ If the outcome is certain, its entropy is zero: there is no uncertainty left to resolve.²",
            }
          : {}),
      };
    },
    async extract(source) {
      return {
        ...source,
        excerpts: [
          "The expected number of bits required to describe the outcome.",
          "Shannon's measure quantifies missing information: how much we do not yet know about the outcome. A fair coin has one bit of entropy.",
        ],
      };
    },
  };
}
