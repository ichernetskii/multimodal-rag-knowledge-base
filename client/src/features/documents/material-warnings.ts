export const warningNames: Record<string, string> = {
  VISUAL_SOURCE_REVIEW_REQUIRED: 'Compare the image with its saved description',
  SAMPLED_VIDEO_REVIEW_REQUIRED:
    'Check the selected video segments; content between them may be omitted',
  AUDIO_SOURCE_REVIEW_REQUIRED: 'Listen to the recording and check its transcript',
  OCR_REVIEW_REQUIRED: 'Check recognized text',
  OCR_LOW_CONFIDENCE: 'Low recognition confidence',
  OCR_UNAVAILABLE_OR_FAILED: 'OCR extracted no text',
  NO_TEXT: 'No text extracted',
  MACHINE_TRANSCRIPT_REVIEW_REQUIRED: 'Review the machine transcript',
  MACHINE_DESCRIPTION_REVIEW_REQUIRED: 'Review the machine description',
  USER_CORRECTED: 'Text corrected by an editor',
  AUTO_TEXT_REVIEW_REQUIRED: 'Text prepared for a new search index — compare with the original',
};
