import {PlotLayer} from "./PlotLayer";
import {Plot, findColIndex, findColIndexOrNull} from "./Plot";
import {assert, ensure} from "../utils/assert";

export interface CanvasScatterPoint {
    x: number;
    y: number;
    low: number;
    high: number;
    color: string;
}

export class ScatterLayer extends PlotLayer {
    ctx: CanvasRenderingContext2D;
    points: CanvasScatterPoint[] = [];

    constructor(plot: Plot) {
        super(plot);
        this.ctx = this.canvas.getContext('2d');
    }

    clean() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    draw() {
        const ctx = this.ctx;

        const margin = this.plot.margins;
        const W = this.plot.width, H = this.plot.height;
        const w = this.plot.width - margin.left - margin.right;
        const h = this.plot.height - margin.top - margin.bottom;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.translate(0.5, 0.5);

        for (let point of this.points) {
            assert(point.high <= point.y);
            assert(point.low >= point.y);

            // Adjust to pixel grid
            const x = Math.round(point.x);
            const y = Math.round(point.y);

            // Error bar
            ctx.strokeStyle = point.color;
            ctx.beginPath();
            ctx.moveTo(x, Math.round(point.low));
            ctx.lineTo(x, Math.round(point.high));
            ctx.stroke();

            // Circle
            ctx.fillStyle = point.color;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, 2 * Math.PI);
            ctx.fill();
        }

        ctx.restore();
    }
    
    public replaceDataPoints() {
        const plot = this.plot;
        const xScale = plot.xScale;
        const yScale = plot.yScale;
        const xVar = ensure(plot.config.xVar);
        var colorScale = d3.scale.category10();

        const points = this.points;
        points.length = 0;

        for (let yVar of plot.config.yVars) {
            const tables = plot.tableCache.getTablesWithVariables(xVar, yVar);
            for (let table of tables) {
                const colX = findColIndex(xVar, table);
                const colY = findColIndexOrNull(yVar, table);
                if (colY == null) {
                    // This table does not have this yVar, but may have other y
                    // variables.
                    continue;
                }
                const color = colorScale(yVar + '-' + table.table_num + '-' + table.publication.inspire_record);

                for (let row of table.data_points) {
                    const x = row[colX].value;
                    const y = row[colY].value;
                    if (x == null || y == null) {
                        // Don't add points for undefined data
                        continue;
                    }

                    const point: CanvasScatterPoint = {
                        x: xScale(x),
                        y: yScale(y),
                        low: yScale(y - row[colY].error_down),
                        high: yScale(y + row[colY].error_up),
                        color: color,
                    };
                    assert(!isNaN(point.low));
                    assert(!isNaN(point.high));
                    points.push(point);
                }
            }
        }
    }
}