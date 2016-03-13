///<reference path="../filters/Filter.ts"/>

class FilterShellComponent {
    parentFilter: CompoundFilter;
    filter: Filter;

    constructor(params: {
        filter: Filter;
        parentFilter: CompoundFilter;
    }) {
        this.filter = params.filter;
        this.parentFilter = params.parentFilter;
    }

    get component() {
        return this.filter.getComponent();
    }

    isRoot() {
        return this.parentFilter == null;
    }

    removeFilter() {
        this.parentFilter.children.remove(this.filter);
    }

    isRemoveAllowed() {
        return !this.isRoot() && this.filter.isRemoveAllowed();
    }
}

ko.components.register('filter-shell', {
    viewModel: FilterShellComponent,
    template: { fromUrl: 'filter-shell.html' },
});