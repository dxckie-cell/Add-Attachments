(function () {
  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { after } = vendetta.patcher;
  const { storage } = vendetta.plugin;
  const { useProxy } = vendetta.storage;
  const { FormSection, FormSwitchRow } = vendetta.ui.components.Forms;
  const { ScrollView } = ReactNative;

  // storage key -> labels (lowercase) that the row can have
  const BUTTONS = [
    { key: "apps", title: "Apps", labels: ["apps"], default: true },
    { key: "markUnread", title: "Mark Unread", labels: ["mark unread"], default: true },
    { key: "translate", title: "Translate Message", labels: ["translate message", "translate"] },
    { key: "forward", title: "Forward", labels: ["forward"] },
    { key: "reply", title: "Reply", labels: ["reply"] },
    { key: "copyText", title: "Copy Text", labels: ["copy text"], default: true },
    { key: "createThread", title: "Create Thread", labels: ["create thread"], default: true },
    { key: "pin", title: "Pin / Unpin Message", labels: ["pin message", "unpin message"] },
    { key: "copyLink", title: "Copy Message Link", labels: ["copy message link"] },
    { key: "silentDelete", title: "Silent Delete", labels: ["silent delete"] },
    { key: "edit", title: "Edit Message", labels: ["edit message"], default: true },
    { key: "delete", title: "Delete Message", labels: ["delete message"], default: true },
    { key: "message", title: "Message", labels: ["message"], default: true },
    { key: "mention", title: "Mention", labels: ["mention"], default: true },
  ];

  let unpatches = [];
  const patched = new WeakSet();

  function hiddenSet() {
    const s = new Set();
    for (const b of BUTTONS) if (storage[b.key]) b.labels.forEach((l) => s.add(l));
    return s;
  }

  function textsOf(el) {
    const p = el.props || {};
    return [p.label, p.title, p.text, p.accessibilityLabel, p.children]
      .filter((v) => typeof v === "string")
      .map((v) => v.trim().toLowerCase());
  }

  function strip(node, hidden, seen, depth) {
    if (!node || typeof node !== "object" || depth > 80 || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const el = node[i];
        if (el && el.props) {
          const texts = textsOf(el);
          if (storage.debug) texts.forEach((t) => console.log("[HideActionSheetButtons] label:", t));
          if (texts.some((t) => hidden.has(t))) {
            node.splice(i, 1);
            continue;
          }
        }
        strip(el, hidden, seen, depth + 1);
      }
      return;
    }

    if (node.props) {
      for (const k of Object.keys(node.props)) {
        const v = node.props[k];
        if (v && typeof v === "object") strip(v, hidden, seen, depth + 1);
      }
    }
  }

  function patchInstance(instance) {
    if (!instance || patched.has(instance) || typeof instance.default !== "function") return;
    patched.add(instance);
    unpatches.push(
      after("default", instance, (_, tree) => {
        try {
          strip(tree, hiddenSet(), new WeakSet(), 0);
        } catch (e) {
          console.log("[HideActionSheetButtons] error", e);
        }
        return tree;
      })
    );
  }

  function Settings() {
    useProxy(storage);
    return React.createElement(
      ScrollView,
      null,
      React.createElement(
        FormSection,
        { title: "Hide from message action sheet", titleStyleType: "no_border" },
        BUTTONS.map((b) =>
          React.createElement(FormSwitchRow, {
            key: b.key,
            label: "Hide " + b.title,
            value: !!storage[b.key],
            onValueChange: (v) => (storage[b.key] = v),
          })
        )
      ),
      React.createElement(
        FormSection,
        { title: "Scope" },
        React.createElement(FormSwitchRow, {
          label: "Apply to all action sheets",
          subLabel: "Needed for Message / Mention. Turn off to only affect the message long-press menu. Reopen the menu after changing.",
          value: !!storage.allSheets,
          onValueChange: (v) => (storage.allSheets = v),
        })
      ),
      React.createElement(
        FormSection,
        { title: "Troubleshooting" },
        React.createElement(FormSwitchRow, {
          label: "Log row labels (debug)",
          subLabel: "Open a message's menu, then check Revenge's debug logs",
          value: !!storage.debug,
          onValueChange: (v) => (storage.debug = v),
        })
      )
    );
  }

  return {
    onLoad() {
      for (const b of BUTTONS) if (storage[b.key] === undefined) storage[b.key] = !!b.default;
      if (storage.allSheets === undefined) storage.allSheets = true;

      const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
      unpatches.push(
        vendetta.patcher.before("openLazy", LazyActionSheet, ([component, key]) => {
          if (key !== "MessageLongPressActionSheet" && !storage.allSheets) return;
          component.then(patchInstance);
        })
      );
    },
    onUnload() {
      unpatches.forEach((u) => u());
      unpatches = [];
    },
    settings: Settings,
  };
})();
