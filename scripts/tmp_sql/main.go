package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

func main() {
	ctx := context.Background()
	c, err := pgx.Connect(ctx, os.Args[1])
	if err != nil {
		fmt.Println("connect:", err)
		os.Exit(1)
	}
	defer c.Close(ctx)
	for _, q := range os.Args[2:] {
		rows, err := c.Query(ctx, q)
		if err != nil {
			fmt.Println("ERR:", err)
			continue
		}
		for rows.Next() {
			v, _ := rows.Values()
			fmt.Println(v...)
		}
		rows.Close()
	}
}
