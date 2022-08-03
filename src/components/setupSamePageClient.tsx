type json =
  | string
  | number
  | boolean
  | null
  | {
      toJSON: () => string;
    }
  | json[]
  | {
      [key: string]: json;
    };

type SamePageApi = {
  //   addGraphListener: (args: {
  //     operation: string;
  //     handler: (e: json, graph: string) => void;
  //   }) => void;
  //   removeGraphListener: (args: { operation: string }) => void;
  //   sendToGraph: (args: {
  //     graph: string;
  //     operation: string;
  //     data?: {
  //       [k: string]: json;
  //     };
  //   }) => void;
  //   getConnectedGraphs: () => string[];
  //   getNetworkedGraphs: () => string[];
  //   enable: () => void;
  //   disable: () => void;
};

const setupSamePageClient = (isAutoConnect: () => boolean): SamePageApi => {
  return {};
};

export default setupSamePageClient;
