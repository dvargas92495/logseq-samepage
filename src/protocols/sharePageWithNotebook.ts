import type { AppId, InitialSchema, Schema } from "samepage/types";
import loadSharePageWithNotebook from "samepage/protocols/sharePageWithNotebook";
import atJsonParser from "samepage/utils/atJsonParser";
import createHTMLObserver from "samepage/utils/createHTMLObserver";
import { apps } from "samepage/internal/registry";
import type {
  BlockEntity,
  BlockUUIDTuple,
} from "@logseq/libs/dist/LSPlugin.user";
import Automerge from "automerge";
import { openDB, IDBPDatabase } from "idb";
import { v4 } from "uuid";
import dateFormat from "date-fns/format";
//@ts-ignore Fix later, already compiles
import blockGrammar from "../util/blockGrammar.ne";

const toFlexRegex = (key: string): RegExp =>
  new RegExp(`^\\s*${key.replace(/([()])/g, "\\$1")}\\s*$`, "i");

const getSettingValueFromTree = ({
  tree,
  key,
}: {
  tree: BlockEntity[];
  key: string;
}): string => {
  const node = tree.find((s) => toFlexRegex(key).test(s.content.trim()));
  const value = node?.children?.[0]
    ? (node?.children?.[0] as BlockEntity).content
    : "";
  return value;
};

const getSubTree = ({
  key,
  tree = [],
}: {
  key: string;
  tree?: BlockEntity[];
}): BlockEntity => {
  const node = tree.find((s) => toFlexRegex(key).test(s.content.trim()));
  if (node) return node;
  return {
    uuid: "",
    id: 0,
    left: { id: 0 },
    format: "markdown",
    page: { id: 0 },
    parent: { id: 0 },
    unordered: false,
    content: "",
    children: [],
  };
};

const logseqToSamepage = (s: string) =>
  openIdb()
    .then((db) => db.get("logseq-to-samepage", s))
    .then((v) => (v as string) || "");
const saveIdMap = (logseq: string, samepage: string) =>
  openIdb().then((db) =>
    Promise.all([
      db.put("logseq-to-samepage", samepage, logseq),
      db.put("samepage-to-logseq", logseq, samepage),
    ])
  );
let db: IDBPDatabase;
const openIdb = async () =>
  db ||
  (db = await openDB("samepage", 2, {
    upgrade(db) {
      db.createObjectStore("pages");
      db.createObjectStore("logseq-to-samepage");
      db.createObjectStore("samepage-to-logseq");
    },
  }));

const toAtJson = ({ nodes = [] }: { nodes?: BlockEntity[] }): InitialSchema => {
  return flattenTree(nodes)
    .map((n, order) => (index: number) => {
      const { content, annotations } = atJsonParser(blockGrammar, n.content);
      const end = content.length + index;
      const blockAnnotations: Schema["annotations"] = [
        {
          start: index,
          end,
          attributes: {
            level: n.level || 0,
            viewType: "bullet",
          },
          type: "block",
        },
      ];
      return {
        content,
        annotations: blockAnnotations.concat(
          annotations.map((a) => ({
            ...a,
            start: a.start + index,
            end: a.end + index,
          }))
        ),
      };
    })
    .reduce(
      (p, c) => {
        const { content: pc, annotations: pa } = p;
        const { content: cc, annotations: ca } = c(pc.length);
        return {
          content: `${pc}${cc}`,
          annotations: pa.concat(ca),
        };
      },
      {
        content: "",
        annotations: [] as Schema["annotations"],
      }
    );
};

const flattenTree = <T extends { children?: (T | BlockUUIDTuple)[] }>(
  tree: T[]
): Omit<T, "children">[] =>
  tree.flatMap(({ children = [], ...t }) => [
    t,
    ...flattenTree(children.filter((c): c is T => typeof c === "object")),
  ]);

const isContentBlock = (b: BlockEntity) => {
  return !b.content || b.content.replace(/[a-z]+:: [^\n]+\n?/g, "");
};

const calculateState = async (notebookPageId: string) => {
  const nodes = (
    await window.logseq.Editor.getPageBlocksTree(notebookPageId)
  ).filter(isContentBlock);

  return toAtJson({
    nodes,
  });
};

type SamepageNode = {
  content: string;
  level: number;
  annotation: {
    start: number;
    end: number;
    annotations: Schema["annotations"];
  };
};

const applyState = async (notebookPageId: string, state: Schema) => {
  const rootPageUuid = await window.logseq.Editor.getPage(notebookPageId).then(
    (p) => p?.uuid
  );
  const expectedTree: SamepageNode[] = [];
  state.annotations.forEach((anno) => {
    if (anno.type === "block") {
      const currentBlock = {
        content: state.content.slice(anno.start, anno.end).join(""),
        level: anno.attributes.level,
        annotation: {
          start: anno.start,
          end: anno.end,
          annotations: [],
        },
      };
      expectedTree.push(currentBlock);
    } else {
      const block = expectedTree.find(
        (ca) =>
          ca.annotation.start <= anno.start && anno.end <= ca.annotation.end
      );
      if (block) {
        block.annotation.annotations.push(anno);
      }
    }
  });
  expectedTree.forEach((block) => {
    const offset = block.annotation.start;
    const normalizedAnnotations = block.annotation.annotations.map((a) => ({
      ...a,
      start: a.start - offset,
      end: a.end - offset,
    }));
    const annotatedText = normalizedAnnotations.reduce((p, c, index, all) => {
      const appliedAnnotation =
        c.type === "bold"
          ? {
              prefix: "**",
              suffix: `**`,
            }
          : c.type === "highlighting"
          ? {
              prefix: "^^",
              suffix: `^^`,
            }
          : c.type === "italics"
          ? {
              prefix: "_",
              suffix: `_`,
            }
          : c.type === "strikethrough"
          ? {
              prefix: "~~",
              suffix: `~~`,
            }
          : c.type === "link"
          ? {
              prefix: "[",
              suffix: `](${c.attributes.href})`,
            }
          : { prefix: "", suffix: "" };
      all.slice(index + 1).forEach((a) => {
        a.start +=
          (a.start >= c.start ? appliedAnnotation.prefix.length : 0) +
          (a.start >= c.end ? appliedAnnotation.suffix.length : 0);
        a.end +=
          (a.end >= c.start ? appliedAnnotation.prefix.length : 0) +
          (a.end > c.end ? appliedAnnotation.suffix.length : 0);
      });
      return `${p.slice(0, c.start)}${appliedAnnotation.prefix}${p.slice(
        c.start,
        c.end
      )}${appliedAnnotation.suffix}${p.slice(c.end)}`;
    }, block.content);
    block.content = annotatedText;
  });
  const actualTree = await window.logseq.Editor.getPageBlocksTree(
    notebookPageId
  ).then((tree = []) => flattenTree(tree.filter(isContentBlock)));

  const promises = expectedTree
    .map((expectedNode, order) => () => {
      if (actualTree.length > order) {
        const actualNode = actualTree[order] as BlockEntity;
        const blockUuid = actualNode.uuid;
        return window.logseq.Editor.updateBlock(blockUuid, expectedNode.content)
          .catch((e) => Promise.reject(`Failed to update block: ${e.message}`))
          .then(() => {
            if (actualNode.level !== expectedNode.level) {
              const getParent = () => {
                if (expectedNode.level === 1) {
                  return { parent: rootPageUuid, index: -1 };
                }
                const index =
                  order -
                  1 -
                  actualTree
                    .slice(0, order)
                    .reverse()
                    .findIndex((node) => node.level < expectedNode.level);
                return { parent: actualTree[index].uuid, index };
              };
              const { parent, index } = getParent();
              const previousSibling =
                index >= 0
                  ? actualTree
                      .slice(index, order)
                      .reverse()
                      .find((a) => a.level === expectedNode.level)
                  : undefined;
              (previousSibling
                ? window.logseq.Editor.moveBlock(
                    actualNode.uuid,
                    previousSibling.uuid
                  )
                : window.logseq.Editor.moveBlock(actualNode.uuid, parent, {
                    children: true,
                  })
              )
                .then(() => Promise.resolve())
                .catch((e) =>
                  Promise.reject(`Failed to move block: ${e.message}`)
                );
            }
            return Promise.resolve();
          });
      } else {
        const parent =
          expectedNode.level === 1
            ? notebookPageId
            : actualTree
                .slice(0, order)
                .reverse()
                .find((node) => node.level < expectedNode.level)?.uuid || "";

        return window.logseq.Editor.appendBlockInPage(
          parent,
          expectedNode.content
        )
          .then(() => Promise.resolve())
          .catch((e) => Promise.reject(`Failed to append block: ${e.message}`));
      }
    })
    .concat(
      actualTree
        .slice(expectedTree.length)
        .map(
          (a) => () =>
            window.logseq.Editor.removeBlock(a.uuid).catch((e) =>
              Promise.reject(`Failed to remove block: ${e.message}`)
            )
        )
    );

  return promises.reduce((p, c) => p.then(c), Promise.resolve<unknown>(""));
};

const setupSharePageWithNotebook = () => {
  const { unload, updatePage, joinPage, rejectPage, isShared } =
    loadSharePageWithNotebook({
      getCurrentNotebookPageId: () =>
        logseq.Editor.getCurrentPage().then((p) =>
          p && !("page" in p) ? p.name : ""
        ),
      applyState,
      calculateState,
      loadState: async (notebookPageId) =>
        window.logseq.App.getCurrentGraph().then((graph) =>
          openIdb().then((db) =>
            db.get("pages", `${graph?.name || "null"}/${notebookPageId}`)
          )
        ),
      saveState: async (notebookPageId, state) =>
        window.logseq.App.getCurrentGraph().then((graph) =>
          openIdb().then((db) =>
            db.put("pages", state, `${graph?.name || "null"}/${notebookPageId}`)
          )
        ),
      removeState: async (notebookPageId) =>
        window.logseq.App.getCurrentGraph().then((graph) =>
          openIdb().then((db) =>
            db.delete("pages", `${graph?.name || "null"}/${notebookPageId}`)
          )
        ),
      overlayProps: {
        viewSharedPageProps: {
          linkNewPage: (_, title) =>
            window.logseq.Editor.getPage(title)
              .then(
                (page) =>
                  page ||
                  window.logseq.Editor.createPage(
                    title,
                    {},
                    { redirect: false }
                  )
              )
              .then(() => title.toLowerCase()),
          onLinkClick: (notebookPageId, e) => {
            if (e.shiftKey) {
              logseq.Editor.openInRightSidebar(notebookPageId);
            } else {
              window.location.hash = `#/page/${encodeURIComponent(
                notebookPageId
              )}`;
            }
          },
        },
        notificationContainerProps: {
          actions: {
            accept: ({ app, workspace, pageUuid, title }) =>
              // TODO support block or page tree as a user action
              window.logseq.Editor.createPage(title, {}, { redirect: false })
                .then((page) =>
                  page
                    ? joinPage({
                        pageUuid,
                        notebookPageId: page?.name,
                        source: { app: Number(app) as AppId, workspace },
                      }).then(() => {
                        const todayName = dateFormat(
                          new Date(),
                          "MMM do, yyyy"
                        );
                        return window.logseq.Editor.appendBlockInPage(
                          todayName,
                          `Accepted page [[${title}]] from ${
                            apps[Number(app)].name
                          } / ${workspace}`
                        );
                      })
                    : Promise.reject(
                        `Failed to create a page with title ${title}`
                      )
                )

                .then(() => Promise.resolve())
                .catch((e) => {
                  window.logseq.Editor.deletePage(title);
                  console.error(e);
                  return Promise.reject(e);
                }),
            reject: async ({ workspace, app, pageUuid }) =>
              rejectPage({
                source: { app: Number(app) as AppId, workspace },
                pageUuid,
              }),
          },
          api: {
            deleteNotification: (uuid) =>
              window.logseq.Editor.deletePage(`samepage/notifications/${uuid}`),
            addNotification: (not) =>
              window.logseq.Editor.createPage(
                `samepage/notifications/${not.uuid}`,
                {},
                { redirect: false, createFirstBlock: false }
              ).then(
                (newPage) =>
                  newPage &&
                  Promise.all([
                    window.logseq.Editor.appendBlockInPage(
                      newPage.uuid,
                      "Title"
                    ).then(
                      (block) =>
                        block &&
                        window.logseq.Editor.appendBlockInPage(
                          block.uuid,
                          not.title
                        )
                    ),
                    window.logseq.Editor.appendBlockInPage(
                      newPage.uuid,
                      "Description"
                    ).then(
                      (block) =>
                        block &&
                        window.logseq.Editor.appendBlockInPage(
                          block.uuid,
                          not.description
                        )
                    ),
                    window.logseq.Editor.appendBlockInPage(
                      newPage.uuid,
                      "Buttons"
                    ).then(
                      (block) =>
                        block &&
                        Promise.all(
                          not.buttons.map((a) =>
                            window.logseq.Editor.appendBlockInPage(
                              block.uuid,
                              a
                            )
                          )
                        )
                    ),
                    window.logseq.Editor.appendBlockInPage(
                      newPage.uuid,
                      "Data"
                    ).then(
                      (block) =>
                        block &&
                        Promise.all(
                          Object.entries(not.data).map((arg) =>
                            window.logseq.Editor.appendBlockInPage(
                              block.uuid,
                              arg[0]
                            ).then(
                              (block) =>
                                block &&
                                window.logseq.Editor.appendBlockInPage(
                                  block.uuid,
                                  arg[1]
                                )
                            )
                          )
                        )
                    ),
                  ])
              ),
            getNotifications: () =>
              window.logseq.DB.datascriptQuery(
                `[:find (pull ?b [:block/name]) :where [?b :block/name ?title] [(clojure.string/starts-with? ?title  "samepage/notifications/")]]`
              )
                .then((pages: [{ name: string }][]) => {
                  return Promise.all(
                    pages.map((block) =>
                      window.logseq.Editor.getPageBlocksTree(
                        block[0].name
                      ).then((tree) => ({
                        tree,
                        uuid: block[0].name.replace(
                          /^samepage\/notifications\//,
                          ""
                        ),
                      }))
                    )
                  );
                })
                .then((trees) =>
                  trees.map(({ tree, uuid }) => {
                    return {
                      title: getSettingValueFromTree({
                        tree,
                        key: "Title",
                      }),
                      uuid,
                      description: getSettingValueFromTree({
                        tree,
                        key: "Description",
                      }),
                      buttons: (
                        getSubTree({
                          tree,
                          key: "Buttons",
                        }).children || []
                      ).map((act) => (act as BlockEntity).content),
                      data: Object.fromEntries(
                        (
                          getSubTree({
                            tree,
                            key: "Data",
                          }).children || []
                        ).map((act) => [
                          (act as BlockEntity).content,
                          ((act as BlockEntity).children || []).map(
                            (b) => b as BlockEntity
                          )[0]?.content,
                        ])
                      ),
                    };
                  })
                ),
          },
        },
        sharedPageStatusProps: {
          getHtmlElement: async (notebookPageId) => {
            return Array.from(
              window.parent.document.querySelectorAll<HTMLHeadingElement>(
                "h1.title"
              )
            ).find((h) => h.textContent?.toLowerCase() === notebookPageId);
          },
          selector: "h1.title",
          getNotebookPageId: async (h) => {
            return h.textContent?.toLowerCase() || "";
          },
          getPath: (heading) =>
            heading?.parentElement?.parentElement?.parentElement || null,
        },
      },
    });

  const idObserver = createHTMLObserver({
    selector: "a.page-property-key",
    callback: (a: HTMLAnchorElement) => {
      const dataRef = a.getAttribute("data-ref");
      if (dataRef === "samepage") {
        const blockContent = a.closest<HTMLDivElement>("div.block-content");
        if (!blockContent) return;
        const innerContent = blockContent.querySelector<HTMLDivElement>(
          ".block-content-inner"
        );
        if (!innerContent) return;
        if (innerContent.innerText) {
          const blockProperties =
            blockContent.querySelector<HTMLDivElement>(".block-properties");
          if (blockProperties) {
            blockProperties.style.display = "none";
          }
        } else {
          const block = blockContent.closest<HTMLDivElement>("div.ls-block");
          if (block) block.style.display = "none";
        }
      }
    },
  });

  let refreshRef: (() => void) | undefined;
  const clearRefreshRef = () => {
    if (refreshRef) {
      refreshRef?.();
      refreshRef = undefined;
    }
  };
  const bodyListener = async (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (e.metaKey) return;
    if (/^Arrow/.test(e.key)) return;
    if (el.tagName === "TEXTAREA" && el.classList.contains("normal-block")) {
      const blockUuid =
        el.id.match(
          /^edit-block-\d+-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
        )?.[1] || "";
      const notebookPage = await window.logseq.Editor.getBlock(blockUuid).then(
        (block) => block && window.logseq.Editor.getPage(block.page.id)
      );
      const notebookPageId = notebookPage?.name || "";
      if (isShared(notebookPageId)) {
        clearRefreshRef();
        refreshRef = window.logseq.DB.onBlockChanged(blockUuid, async () => {
          const doc = await calculateState(notebookPageId);
          updatePage({
            notebookPageId,
            label: `Refresh`,
            callback: (oldDoc) => {
              clearRefreshRef();
              oldDoc.content.deleteAt?.(0, oldDoc.content.length);
              oldDoc.content.insertAt?.(0, ...new Automerge.Text(doc.content));
              if (!oldDoc.annotations) oldDoc.annotations = [];
              oldDoc.annotations.splice(0, oldDoc.annotations.length);
              doc.annotations.forEach((a) => oldDoc.annotations.push(a));
            },
          });
        });
      }
    }
  };
  window.parent.document.body.addEventListener("keydown", bodyListener);

  return () => {
    clearRefreshRef();
    window.parent.document.body.removeEventListener("keydown", bodyListener);
    idObserver.disconnect();
    unload();
  };
};

export default setupSharePageWithNotebook;
