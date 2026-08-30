import { memo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { type PortfolioPoint } from '@workspace/api-client-react';

const formatTime = (label: string) => {
  const d = new Date(label);
  if (isNaN(d.getTime())) return label;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatDateTime = (label: string) => {
  const d = new Date(label);
  if (isNaN(d.getTime())) return label;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function NavChartImpl({ history }: { history?: PortfolioPoint[] }) {
  if (!history || history.length < 2) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground border border-dashed border-border rounded-xl bg-background leading-relaxed text-center px-6">NAV tracking begins with your first deposit.</div>;
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={history} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="navGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <XAxis 
          dataKey="label" 
          stroke="#ffffff33" 
          fontSize={10} 
          tickLine={false} 
          axisLine={false}
          minTickGap={40}
          tickFormatter={formatTime}
        />
        <YAxis 
          domain={['auto', 'auto']}
          stroke="#ffffff33"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          tickFormatter={(val) => `$${(val / 1000).toFixed(1)}k`}
          width={58}
        />
        <Tooltip 
          cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeWidth: 1, strokeDasharray: '3 3' }}
          contentStyle={{ backgroundColor: 'rgba(5,5,5,0.9)', borderColor: 'rgba(255,255,255,0.1)', borderRadius: '8px', backdropFilter: 'blur(10px)' }}
          itemStyle={{ color: '#fff', fontSize: '14px', fontFamily: 'monospace' }}
          labelStyle={{ color: 'rgba(255,255,255,0.5)', fontSize: '10px', textTransform: 'uppercase', marginBottom: '4px' }}
          formatter={(value: number) => [`$${value.toLocaleString()}`, 'NAV']}
          labelFormatter={(label) => formatDateTime(String(label))}
        />
        <Area 
          type="monotone" 
          dataKey="value" 
          stroke="#FC3B00" 
          strokeWidth={2}
          fillOpacity={1} 
          fill="url(#navGradient)" 
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
// Memoized: rebuilding the Recharts SVG tree on every dashboard poll is the
// single most expensive recurring render in the console.
export const NavChart = memo(NavChartImpl);
