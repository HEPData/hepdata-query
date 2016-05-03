///<reference path="../typings/browser.d.ts"/>

import AllFilter = require("filters/AllFilter");

// Ensure template loading works
import 'base/templateFromUrlLoader';

// Ensure components are pulled as a dependencies
import 'bindings/all-bindings';
import 'components/all-components';
import {IndepVarFilter, DepVarFilter} from "./filters/filter-factories";

// Ensure template utility functions are pulled too
import 'utils/recordCountFormat';
import {elastic} from "./services/Elastic";
import {DataPoint, PublicationTable} from "./base/dataFormat";
import TableCache = require("./services/TableCache");
import {PlotPool} from "./services/PlotPool";
import {Plot} from "./visualization/Plot";
import {assertHas, assert} from "./utils/assert";
import {map, imap, sum, union, range} from "./utils/map";
import CMEnergiesFilter = require("./filters/CMEnergiesFilter");
import {Filter} from "./filters/Filter";
import {StateDump} from "./base/StateDump";
import {stateStorage} from "./services/StateStorage";
import {customUrlHash} from "./utils/customUrlHash";

declare function stableStringify(thing: any): string;

function screenUpdated() {
    return new Promise(function (resolve, reject) {
        window.requestAnimationFrame(resolve)
    });
}

enum ProcessingState {
    Done,
    Downloading,
    Rendering,
}

const regexStateId = /^#([\w1-9]+)$/;

class AppViewModel {
    rootFilter: Filter;
    currentStateDump: KnockoutComputed<string>
    processingState: ProcessingState = ProcessingState.Done;
    tableCache = new TableCache;
    plotPool: PlotPool;
    // The 'loading' screen only appears on the first data load since the page started
    firstLoad = true;

    constructor() {
        this.plotPool = new PlotPool(this.tableCache);
        this.rootFilter = new AllFilter([
            new IndepVarFilter('PT (GEV)'),
            // new DepVarFilter('D(N)/DPT (c/GEV)'),
            // new CMEnergiesFilter()
        ]);
        ko.track(this, ['processingState', 'firstLoad', 'rootFilter']);

        this.currentStateDump = ko.computed(this.dumpApplicationState, this);
        this.currentStateDump.subscribe(this.updatedStateDump, this);

        this.loadData();

        // TODO A bit quirky... should add a loading screen or something
        this.loadNewHash(location.hash);
    }
    
    isLoading() {
        return this.processingState != ProcessingState.Done;
    }
    
    isRendering() {
        return this.processingState == ProcessingState.Rendering;
    }

    private dumpApplicationState(): string {
        const state: StateDump = {
            version: 1,
            filter: this.rootFilter.dump()
        };
        return stableStringify(state);
    }
    
    private loadDataPromise: Promise<PublicationTable[]> = Promise.resolve(null);
    
    private loadData() {
        this.loadDataPromise.cancel();
        this.processingState = ProcessingState.Downloading;
        
        this.loadDataPromise = elastic.fetchFilteredData(this.rootFilter);
        this.loadDataPromise
            .then((tables: PublicationTable[]) => {
                this.processingState = ProcessingState.Rendering;

                // Wait one frame for the screen to update
                return screenUpdated()
                    // Continue with the next step
                    .then(() => tables);
            })
            .then((tables: PublicationTable[]) => {
                var t1 = performance.now();

                this.tableCache.replaceAllTables(tables);
                this.updateUnpinnedPlots();

                var t2 = performance.now();
                console.log("Data indexed in %.2f ms.", t2 - t1);

                this.processingState = ProcessingState.Done;
                this.firstLoad = false;
            })
    }

    updateUnpinnedPlots() {
        // After the next loop, this variable will hold how many free plots we have
        let remainingPlots = this.plotPool.maxPlots;

        // Update every plot data
        for (let plot of this.plotPool.plots) {
            if (plot.alive) {
                // Update data
                plot.loadTables();
                // Kill if no data is matched with the new tables
                if (plot.isEmpty()) {
                    plot.kill();
                } else {
                    remainingPlots--;
                }
            }
        }

        // Continue only if we still have free plots
        assert(remainingPlots >= 0, 'remainingPlots >= 0');
        if (remainingPlots == 0) {
            return;
        }

        // Compute how many data points there are for each (dep var, indep var) pair
        const countByVariablePair = new Map2<string,string,number>();
        for (let table of this.tableCache.allTables) {
            for (let depVar of table.dep_vars) {
                for (let indepVar of table.indep_vars) {
                    const oldCount = countByVariablePair.get(indepVar.name, depVar.name) || 0;
                    const newCount = oldCount + table.data_points.length; 
                    countByVariablePair.set(indepVar.name, depVar.name, newCount);
                }
            }
        }
        
        // Sort the pairs by data point count
        const countByVariablePairSorted = _.sortBy(Array.from(countByVariablePair.entries()),
            ([indepVar, depVar, dataPointCount]) => {
                return -dataPointCount
            });

        // Now comes assigning plots to the variable pairs.
        // It works like this: Each plot has one independent variable and upto 
        // `maxPlotVars` dependent variables.
        const maxPlotVars = 5;
        // `freePlotSlots` plots can be added in total.
        let freePlotSlots = remainingPlots;
        let freeVariableSlots = remainingPlots * maxPlotVars;
        
        const groupsAssigned = new Map<string, PlotGroupConfiguration>();
        
        /** We define a 'plot group' as a pair of (xVar, yVars). A plot group may
         * be split later into one or more plots.
         */ 
        class PlotGroupConfiguration {
            /** Will be assigned an independent variable. */
            xVar: string;
            /** Will be assigned one or more dependent variables. */
            yVars: string[] = [];
            
            plotsAllocated = 1;
            /** How many variables we can add to yVars without requiring a new plot. */
            variableSlotsFree = maxPlotVars;
            
            constructor(xVar: string) {
                assert(freePlotSlots > 0, 'No plot slots available');
                this.xVar = xVar;
                
                freePlotSlots -= 1;
                groupsAssigned.set(xVar, this);
            }
            
            addVariable(yVar: string) {
                assert(this.variableSlotsFree > 0, 'No variable slots available');
                
                this.yVars.push(yVar);
                this.variableSlotsFree -= 1;
                freeVariableSlots -= 1;
            }
            
            allocateAnotherPlot() {
                assert(freePlotSlots > 0, 'No plot slots available');
                assert(this.variableSlotsFree == 0, 'Unnecessary plot allocation');
                
                this.plotsAllocated += 1;
                this.variableSlotsFree += maxPlotVars;
                freePlotSlots -= 1;
            }
        }
        
        for (let [indepVar, depVar, dataPointCount] of countByVariablePairSorted) {
            const existingGroup = groupsAssigned.get(indepVar);
            if (!existingGroup) {
                if (freePlotSlots > 0) {
                    // No plot group exists for this indepVar, but we have room
                    // for a new one. 
                    const group = new PlotGroupConfiguration(indepVar);
                    group.addVariable(depVar);
                }
            } else {
                // A group for this indepVar variable already exists
                if (existingGroup.variableSlotsFree) {
                    // If it has no room for more variables already try to get
                    // a new plot.
                    if (existingGroup.variableSlotsFree == 0 && freePlotSlots > 0) {
                        existingGroup.allocateAnotherPlot();
                    }
                    
                    // If it has enough space, add the variable
                    if (existingGroup.variableSlotsFree > 0) {
                        existingGroup.addVariable(depVar);
                    }
                }
            }
        }
        
        // Before we can create the plots, we have to split the groups in plots 
        // of up to `maxPlotVars` variables.
        
        // At this point the algorithm it's a bit naive in that it chooses them
        // randomly by the order they were inserted. It could be improved to
        // always put some groups of related variables (e.g. 'expected' and 
        // 'observed' variables) in the same plot. 

        for (let group of groupsAssigned.values()) {
            for (let numPlot of range(group.plotsAllocated)) {
                const yVars = group.yVars.slice(numPlot * maxPlotVars,
                                                (numPlot + 1) * maxPlotVars);
                
                // Finally, we add the new plot now
                const plot = this.plotPool.getFreePlot().spawn(group.xVar, yVars);
            }
        }
    }

    private updatedStateDump(stateDump: string)  {
        // Calculate a new URL hash and persist it to the server
        // asynchronously.
        //
        // We set the urlHash *before* it exists in the server. Hopefully
        // by the time the user has shared a link the store request will
        // have succeed.
        const urlHash = customUrlHash(stateDump);
        history.replaceState(null, null, '#' + urlHash);
        stateStorage.put(urlHash, stateDump);


        // Query data with the new filters.
        // TODO do this only when filter has changed (in the future the
        // state dump will also have other modifiable information).
        this.loadData();
    }

    public loadStateDump(stateDump: StateDump) {
        if (stateDump.version != 1) {
            console.warn('Unknown state dump version: ' + stateDump.version);
        }
        this.rootFilter = Filter.load(stateDump.filter);
    }

    public loadNewHash(hash: string) {
        const match = regexStateId.exec(hash);
        if (!match) {
            if (hash != '' && hash != '#') {
                console.warn('No match on URL hash: ' + hash);
            }
            return;
        }
        const id = match[1];
        stateStorage.get(id)
            .then((stateDump) => {
                this.loadStateDump(stateDump);
            });
    }
}

window.onhashchange = function () {
    console.log('User changed hash: ' + location.hash);
    app.loadNewHash(location.hash);
};

const app = new AppViewModel();
(<any>window).app = app;
export = app;

ko.applyBindings(app);