'use client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useState} from 'react';
export function Providers({children}:{children:React.ReactNode}){
  const [q]=useState(()=>new QueryClient({defaultOptions:{
    // 会话数据以 mutation 成功后的整体失效为准；查询避免窗口聚焦即全量 refetch。
    queries:{staleTime:30_000,refetchOnWindowFocus:false},
  }}));
  return <QueryClientProvider client={q}>{children}</QueryClientProvider>;
}
