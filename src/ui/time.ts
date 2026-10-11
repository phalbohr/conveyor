const two = (value: number) => String(value).padStart(2, '0')

export const clock = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`

export const dateTime = (iso: string) => {
  const date = new Date(iso)
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}. ${two(date.getHours())}:${two(date.getMinutes())}`
}
