export const dataFactory = <T extends Record<string, unknown>>() => {
  let data: Map<keyof T, T[keyof T]> = new Map();

  return {
    setInitial: (json: T) => {
      data = new Map<keyof T, T[keyof T]>(entries(json));
    },
    object: () => {
      return {
        ...Object.fromEntries(data) as Record<keyof T, T[keyof T]>,
        pick: (picked: keyof T) => data.get(picked),
        omit: (keys: Array<keyof T>) => {
          const entries = Array.from(data).filter(([key]) => !keys.includes(key as keyof T));
          return Object.fromEntries(entries);
        }
      };
    },
    set: (k: keyof T, v: T[keyof T]) => data.set(k, v),
    get: (k: keyof T) => data.get(k),
    response: <T extends Record<string, unknown>>(input: T) => {
      const entries: [keyof T, T[keyof T]][] = [];
    
      for (const [key, value] of Object.entries(input)) {
        if (value !== null) {
          entries.push([key as keyof T, value as T[keyof T]]);
        }
      }
    
      const _data = new Map<keyof T, T[keyof T]>(entries);
      return Object.fromEntries(_data);
    },
  };
};

const entries = <T extends Record<string, unknown>>(
  obj: T
): [keyof T, T[keyof T]][] => {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
};
