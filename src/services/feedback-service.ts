import type { SubmitFeedbackBody } from "../models/feedback.js";
import type { FeedbackRepository } from "../repositories/feedback-repo.js";

export class FeedbackService {
  readonly #repo: FeedbackRepository;

  constructor(deps: { feedbackRepo: FeedbackRepository }) {
    this.#repo = deps.feedbackRepo;
  }

  async submit(userId: string, submission: SubmitFeedbackBody): Promise<void> {
    await this.#repo.insert(userId, submission);
  }
}
