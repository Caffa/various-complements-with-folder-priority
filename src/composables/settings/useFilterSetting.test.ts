import { describe, expect, it, jest } from "@jest/globals";
import type { SearchComponent, Setting } from "obsidian";
import {
  createSettingsFilterRegistry,
  useFilterSetting,
} from "./useFilterSetting";

interface FakeElement {
  hidden: boolean;
  toggle: (visible: boolean) => void;
}

const createFakeElement = (): FakeElement & HTMLElement => {
  const el: FakeElement = {
    hidden: false,
    toggle: (visible: boolean) => {
      el.hidden = !visible;
    },
  };
  return el as unknown as FakeElement & HTMLElement;
};

interface FakeSetting extends Setting {
  name: string;
  desc: string | DocumentFragment;
  settingEl: FakeElement & HTMLElement;
}

const createFakeSetting = (): FakeSetting => {
  const setting = {
    name: "",
    desc: "" as string | DocumentFragment,
    settingEl: createFakeElement(),
    setName: (n: string) => {
      setting.name = n;
      return setting;
    },
    setDesc: (d: string | DocumentFragment) => {
      setting.desc = d;
      return setting;
    },
    setClass: () => setting,
    setHeading: () => setting,
    addText: () => setting,
    addToggle: () => setting,
    addDropdown: () => setting,
    addSlider: () => setting,
    addTextArea: () => setting,
  };
  return setting as unknown as FakeSetting;
};

interface FakeGroup {
  settings: FakeSetting[];
  addSearch: jest.Mock<(cb: (sc: FakeSearchComponent) => unknown) => FakeGroup>;
  addSetting: (cb: (setting: Setting) => void) => FakeGroup;
  addClass: () => FakeGroup;
  setHeading: () => FakeGroup;
  addExtraButton: () => FakeGroup;
}

const createFakeGroup = (): FakeGroup => {
  const settings: FakeSetting[] = [];
  const group = {
    settings,
    addSetting: (cb: (setting: Setting) => void) => {
      const setting = createFakeSetting();
      settings.push(setting);
      cb(setting);
      return group;
    },
    addSearch: jest.fn((cb: (sc: FakeSearchComponent) => unknown) => {
      cb(createFakeSearchComponent());
      return group;
    }),
    addClass: () => group,
    setHeading: () => group,
    addExtraButton: () => group,
  };
  return group as unknown as FakeGroup;
};

interface FakeSearchComponent extends SearchComponent {
  triggerChange(value: string): void;
}

const createFakeSearchComponent = (): FakeSearchComponent => {
  let onChangeCb: ((value: string) => void) | null = null;
  const sc = {
    setPlaceholder: () => sc,
    onChange: (cb: (value: string) => void) => {
      onChangeCb = cb;
      return sc;
    },
    triggerChange: (value: string) => onChangeCb?.(value),
  };
  return sc as unknown as FakeSearchComponent;
};

describe("useFilterSetting", () => {
  it("no options keeps the legacy path with an independent per-group search", () => {
    const groupA = createFakeGroup();
    const { addFilterableSetting: addA } = useFilterSetting(groupA);
    expect(groupA.addSearch).toHaveBeenCalledTimes(1);

    const groupB = createFakeGroup();
    const { addFilterableSetting: addB } = useFilterSetting(groupB);
    expect(groupB.addSearch).toHaveBeenCalledTimes(1);

    addA("Alpha", null, () => {});
    addB("Beta", null, () => {});

    const scA = createFakeSearchComponent();
    groupA.addSearch.mock.calls[0][0](scA);
    scA.triggerChange("bet");

    expect(groupA.settings[0].settingEl.hidden).toBe(true);
    expect(groupB.settings[0].settingEl.hidden).toBe(false);
  });

  it("registry path does not call addSearch and uses a shared query", () => {
    const registry = createSettingsFilterRegistry();
    const group = createFakeGroup();
    const header = createFakeElement();
    const { addFilterableSetting } = useFilterSetting(group, {
      registry,
      headerEl: header,
    });

    expect(group.addSearch).not.toHaveBeenCalled();

    addFilterableSetting("Alpha", null, () => {});
    registry.applyFilter("alp");

    expect(group.settings[0].settingEl.hidden).toBe(false);
    expect(header.hidden).toBe(false);
  });

  it("empty query shows only predicate-passing settings and always-visible headers", () => {
    const registry = createSettingsFilterRegistry();
    const group = createFakeGroup();
    const header = createFakeElement();
    const conditionalEl = createFakeElement();
    const { addFilterableSetting, addConditionalElement } = useFilterSetting(
      group,
      { registry, headerEl: header },
    );

    addFilterableSetting("Alpha", null, () => {}, { visible: () => false });
    addConditionalElement(conditionalEl, () => true);

    expect(group.settings[0].settingEl.hidden).toBe(true);
    expect(conditionalEl.hidden).toBe(false);
    expect(header.hidden).toBe(false);
  });

  it("non-empty query hides headers and conditionals for sections without a match", () => {
    const registry = createSettingsFilterRegistry();

    const groupA = createFakeGroup();
    const headerA = createFakeElement();
    const conditionalA = createFakeElement();
    const { addFilterableSetting: addA, addConditionalElement: condA } =
      useFilterSetting(groupA, { registry, headerEl: headerA });

    const groupB = createFakeGroup();
    const headerB = createFakeElement();
    const conditionalB = createFakeElement();
    const { addFilterableSetting: addB, addConditionalElement: condB } =
      useFilterSetting(groupB, { registry, headerEl: headerB });

    addA("Alpha", null, () => {});
    condA(conditionalA, () => true);
    addB("Beta", null, () => {});
    condB(conditionalB, () => true);

    registry.applyFilter("alp");

    expect(groupA.settings[0].settingEl.hidden).toBe(false);
    expect(headerA.hidden).toBe(false);
    expect(conditionalA.hidden).toBe(false);

    expect(groupB.settings[0].settingEl.hidden).toBe(true);
    expect(headerB.hidden).toBe(true);
    expect(conditionalB.hidden).toBe(true);
  });

  it("conditional stays hidden when its predicate is false even if the section matches", () => {
    const registry = createSettingsFilterRegistry();
    const group = createFakeGroup();
    const header = createFakeElement();
    const conditionalEl = createFakeElement();
    const { addFilterableSetting, addConditionalElement } = useFilterSetting(
      group,
      { registry, headerEl: header },
    );

    addFilterableSetting("Alpha", null, () => {});
    addConditionalElement(conditionalEl, () => false);

    registry.applyFilter("alp");

    expect(group.settings[0].settingEl.hidden).toBe(false);
    expect(conditionalEl.hidden).toBe(true);
    expect(header.hidden).toBe(false);
  });

  it("refresh re-applies the current global query after a predicate changes", () => {
    const registry = createSettingsFilterRegistry();
    const group = createFakeGroup();
    const header = createFakeElement();
    let visible = true;
    const { addFilterableSetting, refresh } = useFilterSetting(group, {
      registry,
      headerEl: header,
    });

    addFilterableSetting("Alpha", null, () => {}, { visible: () => visible });

    registry.applyFilter("alp");
    expect(group.settings[0].settingEl.hidden).toBe(false);

    visible = false;
    refresh();
    expect(group.settings[0].settingEl.hidden).toBe(true);
    expect(header.hidden).toBe(true);
  });

  it("matches case-insensitive trimmed substrings", () => {
    const registry = createSettingsFilterRegistry();
    const group = createFakeGroup();
    const header = createFakeElement();
    const { addFilterableSetting } = useFilterSetting(group, {
      registry,
      headerEl: header,
    });

    addFilterableSetting("Alpha Beta", null, () => {});

    registry.applyFilter("  BETA ");

    expect(group.settings[0].settingEl.hidden).toBe(false);
    expect(header.hidden).toBe(false);
  });
});
