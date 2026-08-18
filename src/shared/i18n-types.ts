type EnglishCatalog = typeof import('../../_locales/en/messages.json');

export type MessageKey = keyof EnglishCatalog;

export type LocalizedMessage = {
  key: MessageKey;
  substitutions?: readonly (string | number)[];
};

export const message = (
  key: MessageKey,
  substitutions?: readonly (string | number)[],
): LocalizedMessage => ({ key, ...(substitutions ? { substitutions } : {}) });

export function dedupeMessages(messages: readonly LocalizedMessage[]): LocalizedMessage[] {
  return [
    ...new Map(
      messages.map((item) => [`${item.key}:${JSON.stringify(item.substitutions ?? [])}`, item]),
    ).values(),
  ];
}
