import type { Setting, SettingGroup } from "obsidian";

const ALWAYS_VISIBLE = () => true;

export interface SettingsFilterSection {
  headerEl: HTMLElement | null;
  filterTargets: Array<{
    settingEl: HTMLElement;
    getSearchText: () => string;
    isVisible: () => boolean;
  }>;
  conditionalElements: Array<{
    el: HTMLElement;
    isVisible: () => boolean;
  }>;
}

export interface SettingsFilterRegistry {
  registerSection(headerEl: HTMLElement | null): SettingsFilterSection;
  addFilterTarget(
    section: SettingsFilterSection,
    settingEl: HTMLElement,
    searchText: string,
    isVisible?: () => boolean,
  ): void;
  addConditionalElement(
    section: SettingsFilterSection,
    el: HTMLElement,
    isVisible: () => boolean,
  ): void;
  applyFilter(query: string): void;
  refresh(): void;
}

export function createSettingsFilterRegistry(): SettingsFilterRegistry {
  const sections: SettingsFilterSection[] = [];
  let latestQuery = "";

  const registerSection = (
    headerEl: HTMLElement | null,
  ): SettingsFilterSection => {
    const section: SettingsFilterSection = {
      headerEl,
      filterTargets: [],
      conditionalElements: [],
    };
    sections.push(section);
    return section;
  };

  const addFilterTarget = (
    section: SettingsFilterSection,
    settingEl: HTMLElement,
    searchText: string,
    isVisible: () => boolean = ALWAYS_VISIBLE,
  ) => {
    section.filterTargets.push({
      settingEl,
      getSearchText: () => searchText,
      isVisible,
    });
    applyFilter(latestQuery);
  };

  const addConditionalElement = (
    section: SettingsFilterSection,
    el: HTMLElement,
    isVisible: () => boolean,
  ) => {
    section.conditionalElements.push({ el, isVisible });
    applyFilter(latestQuery);
  };

  const applyFilter = (query: string) => {
    latestQuery = query;
    const normalizedQuery = query.trim().toLowerCase();
    const shouldShowAll = normalizedQuery.length === 0;

    for (const section of sections) {
      let sectionHasVisibleMatch = false;

      for (const target of section.filterTargets) {
        const searchText = target.getSearchText().toLowerCase();
        const isMatch = shouldShowAll || searchText.includes(normalizedQuery);
        const visible = isMatch && target.isVisible();
        target.settingEl.toggle(visible);
        if (visible) {
          sectionHasVisibleMatch = true;
        }
      }

      for (const conditional of section.conditionalElements) {
        const visible =
          conditional.isVisible() && (shouldShowAll || sectionHasVisibleMatch);
        conditional.el.toggle(visible);
      }

      if (section.headerEl) {
        section.headerEl.toggle(shouldShowAll || sectionHasVisibleMatch);
      }
    }
  };

  const refresh = () => applyFilter(latestQuery);

  return {
    registerSection,
    addFilterTarget,
    addConditionalElement,
    applyFilter,
    refresh,
  };
}

interface UseFilterSettingOptions {
  registry?: SettingsFilterRegistry;
  headerEl?: HTMLElement;
}

export const useFilterSetting = (
  group: SettingGroup,
  options?: UseFilterSettingOptions,
) => {
  if (options?.registry) {
    const section = options.registry.registerSection(options.headerEl ?? null);

    const addFilterableSetting = (
      name: string,
      desc: string | DocumentFragment | null,
      build: (setting: Setting) => void,
      option?: { visible?: () => boolean },
    ) => {
      const searchText = name.trim();
      group.addSetting((setting) => {
        setting.setName(name);
        if (desc) {
          setting.setDesc(desc);
        }
        build(setting);
        options.registry!.addFilterTarget(
          section,
          setting.settingEl,
          searchText,
          option?.visible ?? ALWAYS_VISIBLE,
        );
      });
    };

    const addConditionalElement = (
      el: HTMLElement,
      isVisible: () => boolean,
    ) => {
      options.registry!.addConditionalElement(section, el, isVisible);
    };

    const refresh = () => options.registry!.refresh();

    return { addFilterableSetting, addConditionalElement, refresh };
  }

  const filterTargets: {
    settingEl: HTMLElement;
    getSearchText: () => string;
    isVisible: () => boolean;
  }[] = [];
  const conditionalElements: {
    el: HTMLElement;
    isVisible: () => boolean;
  }[] = [];
  let latestQuery = "";

  const applyFilter = (query: string) => {
    latestQuery = query;
    const normalizedQuery = query.trim().toLowerCase();
    const shouldShowAll = normalizedQuery.length === 0;
    for (const target of filterTargets) {
      const searchText = target.getSearchText().toLowerCase();
      const isMatch = shouldShowAll || searchText.includes(normalizedQuery);
      target.settingEl.toggle(isMatch && target.isVisible());
    }
    for (const target of conditionalElements) {
      target.el.toggle(target.isVisible());
    }
  };

  const addFilterTarget = (
    element: HTMLElement,
    getSearchText: () => string,
    isVisible: () => boolean,
  ) => {
    filterTargets.push({ settingEl: element, getSearchText, isVisible });
    applyFilter(latestQuery);
  };

  /**
   * Adds a setting to the group.
   * `option.visible` makes the setting depend on another setting: it is shown
   * only while the predicate returns true and the filter query matches.
   */
  const addFilterableSetting = (
    name: string,
    desc: string | DocumentFragment | null,
    build: (setting: Setting) => void,
    option?: { visible?: () => boolean },
  ) => {
    const searchText = name.trim();
    group.addSetting((setting) => {
      setting.setName(name);
      if (desc) {
        setting.setDesc(desc);
      }
      build(setting);
      addFilterTarget(
        setting.settingEl,
        () => searchText,
        option?.visible ?? ALWAYS_VISIBLE,
      );
    });
  };

  /**
   * Registers an element (ex: a warning message) that is shown only while
   * `isVisible` returns true. Unlike settings, it ignores the filter query.
   */
  const addConditionalElement = (el: HTMLElement, isVisible: () => boolean) => {
    conditionalElements.push({ el, isVisible });
    el.toggle(isVisible());
  };

  /**
   * Re-evaluates the visibility of every registered element.
   * Call it after changing a setting that other settings depend on, instead of
   * rebuilding the whole settings tab.
   */
  const refresh = () => {
    applyFilter(latestQuery);
  };

  group.addSearch((sc) => {
    sc.setPlaceholder("Filter settings").onChange((value) => {
      applyFilter(value);
    });
  });

  return { addFilterableSetting, addConditionalElement, refresh };
};
